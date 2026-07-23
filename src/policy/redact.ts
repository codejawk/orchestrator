/**
 * Deterministic redaction for text the user typed or pasted.
 *
 * This closes a hole the file-approval gate does not cover. Every file that
 * reaches an external model has been scanned and explicitly approved — but a
 * developer debugging a battery issue pastes a dumpstate straight into chat,
 * and that text flows into the compiled prompt without ever passing the gate.
 * A dumpstate carries IMEIs, serials, MAC addresses, account emails and build
 * fingerprints.
 *
 * Redaction is regex-only and reversible. Two consequences worth being explicit
 * about:
 *
 *   - It catches *structured* identifiers, not prose. "The Nightfall launch
 *     slipped to Q3" survives redaction untouched. That case is handled by
 *     session tainting instead, which routes the whole run to Gauss.
 *   - Placeholders are stable and restorable, so the model can reason about
 *     "the device with serial <SERIAL_1>" and we can put the real value back in
 *     the answer before showing it to you.
 */

export interface Redaction {
  placeholder: string;
  original: string;
  rule: string;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
  /** Rule ids that fired, for the UI to explain what was removed. */
  rulesFired: string[];
}

interface RedactRule {
  id: string;
  label: string;
  pattern: RegExp;
  /** Prefix for the placeholder, e.g. IMEI → <IMEI_1>. */
  token: string;
  /** Optional guard for patterns a regex alone over-matches. */
  accept?: (match: string) => boolean;
}

/**
 * Ordered most-specific first. A private key block must be consumed before the
 * generic base64 rule gets a chance to shred it into fragments.
 */
export const REDACT_RULES: readonly RedactRule[] = Object.freeze([
  {
    id: 'private-key',
    label: 'private key block',
    token: 'PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'aws-key',
    label: 'AWS access key',
    token: 'AWS_KEY',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'bearer',
    label: 'bearer token',
    token: 'TOKEN',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
  {
    id: 'jwt',
    label: 'JWT',
    token: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'imei',
    label: 'IMEI',
    token: 'IMEI',
    // 15 digits, optionally spaced or hyphenated. Validated with Luhn, because
    // "153000000000000" as a raw byte count is not an IMEI and redacting it
    // would corrupt the log we are trying to read.
    pattern: /\b\d{2}[- ]?\d{6}[- ]?\d{6}[- ]?\d{1}\b|\b\d{15}\b/g,
    accept: (match) => luhnValid(match.replace(/[- ]/g, '')),
  },
  {
    id: 'mac',
    label: 'MAC address',
    token: 'MAC',
    pattern: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g,
  },
  {
    id: 'email',
    label: 'email address',
    token: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    id: 'android-id',
    label: 'Android ID',
    token: 'ANDROID_ID',
    pattern: /\b(?:android_id|androidId)["'\s:=]+([0-9a-f]{16})\b/gi,
  },
  {
    id: 'device-serial',
    label: 'device serial',
    token: 'SERIAL',
    pattern: /\b(?:ro\.serialno|ro\.boot\.serialno|serialno|Serial)\s*[:=]\s*([A-Za-z0-9]{8,20})\b/g,
  },
  {
    id: 'secret-assignment',
    label: 'hardcoded credential',
    token: 'SECRET',
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/gi,
  },
]);

/**
 * Replaces sensitive spans with stable placeholders.
 *
 * Identical values share a placeholder, so a log mentioning one IMEI forty
 * times still reads coherently and costs forty tokens rather than forty
 * redaction markers with different numbers.
 */
export function redactSecrets(
  text: string,
  rules: readonly RedactRule[] = REDACT_RULES,
): RedactionResult {
  const redactions: Redaction[] = [];
  const rulesFired = new Set<string>();
  const assigned = new Map<string, string>();
  const counters = new Map<string, number>();
  let output = text;

  for (const rule of rules) {
    output = output.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (match) => {
      if (rule.accept && !rule.accept(match)) {
        return match;
      }

      const existing = assigned.get(match);
      if (existing) {
        return existing;
      }

      const next = (counters.get(rule.token) ?? 0) + 1;
      counters.set(rule.token, next);
      const placeholder = `<${rule.token}_${next}>`;

      assigned.set(match, placeholder);
      redactions.push({ placeholder, original: match, rule: rule.label });
      rulesFired.add(rule.label);
      return placeholder;
    });
  }

  return { text: output, redactions, rulesFired: [...rulesFired] };
}

/**
 * Puts the real values back.
 *
 * Applied to model output before it is shown, so a finding that says
 * "device <SERIAL_1> reports 4.2V" reads correctly. The model never saw the
 * serial; you never see the placeholder.
 */
export function restore(text: string, redactions: Redaction[]): string {
  let output = text;
  for (const redaction of redactions) {
    output = output.split(redaction.placeholder).join(redaction.original);
  }
  return output;
}

/** Luhn check digit, used to avoid redacting any random 15-digit number. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{15}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let value = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
  }
  return sum % 10 === 0;
}

/** Human summary for the chat surface. */
export function describeRedactions(result: RedactionResult): string {
  if (result.redactions.length === 0) {
    return '';
  }
  const counts = new Map<string, number>();
  for (const redaction of result.redactions) {
    counts.set(redaction.rule, (counts.get(redaction.rule) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([rule, count]) => `${count} ${rule}${count === 1 ? '' : 's'}`)
    .join(', ');
}
