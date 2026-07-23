import type { ClassificationReason, Tier } from '../types/ir.ts';
import { TIER_RANK } from '../types/ir.ts';

/**
 * Deterministic prefilter, run before Gauss sees anything.
 *
 * Two reasons this exists rather than asking the model everything. It is free
 * and instant, so the obvious cases never cost a scan call. And it is
 * *reliable* in a way an LLM judgement is not — a private key must be caught
 * every single time, and "the model usually notices" is not a security control.
 *
 * Gauss handles what regexes cannot: prose about unreleased plans, architecture
 * that is sensitive by context rather than by token.
 */

export interface PatternRule {
  id: string;
  kind: 'path' | 'content';
  pattern: RegExp;
  tier: Tier;
  /** Shown to the user in the review panel, so write it for a human. */
  description: string;
}

/**
 * Defaults tuned for Samsung platform work. These are a starting point and are
 * meant to be edited — `orchestrator.policy.extraRules` appends to them and
 * `orchestrator.policy.codenames` feeds the codename rule.
 */
export const DEFAULT_RULES: readonly PatternRule[] = Object.freeze([
  // --- Secrets: always restricted, no judgement call involved ----------------
  {
    id: 'private-key',
    kind: 'content',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    tier: 'restricted',
    description: 'Contains a private key block',
  },
  {
    id: 'aws-access-key',
    kind: 'content',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    tier: 'restricted',
    description: 'Contains an AWS access key id',
  },
  {
    id: 'generic-secret-assignment',
    kind: 'content',
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    tier: 'restricted',
    description: 'Contains a hardcoded credential assignment',
  },
  {
    id: 'key-material-file',
    kind: 'path',
    pattern: /\.(?:pem|p12|pfx|jks|keystore|key)$|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
    tier: 'restricted',
    description: 'Key material file',
  },

  // --- Secure boot and trusted execution -----------------------------------
  {
    id: 'bootloader-path',
    kind: 'path',
    pattern:
      /(?:^|\/)(?:bootloader|sboot|u-?boot|lk|little-?kernel|xbl|abl|preloader)(?:\/|[._-]|$)/i,
    tier: 'restricted',
    description: 'Bootloader source path',
  },
  {
    id: 'secure-boot-content',
    kind: 'content',
    pattern:
      /\b(?:secure_?boot|verified_?boot|dm-verity|avb_?(?:verify|slot|hashtree)|rollback_?index|efuse|anti[_-]?rollback)\b/i,
    tier: 'restricted',
    description: 'References secure/verified boot internals',
  },
  {
    id: 'tee-path',
    kind: 'path',
    pattern: /(?:^|\/)(?:trustzone|tzos|teegris|optee|trusty|tee|ta_|trustlet)(?:\/|[._-]|$)/i,
    tier: 'restricted',
    description: 'Trusted execution environment source path',
  },
  {
    id: 'tee-content',
    kind: 'content',
    pattern: /\b(?:TEEGRIS|TrustZone|SMC_?CALL|secure_?monitor|trustlet|keymaster|gatekeeper|RPMB|strongbox)\b/i,
    tier: 'restricted',
    description: 'References trusted execution or key attestation internals',
  },
  {
    id: 'knox-path',
    kind: 'path',
    pattern: /(?:^|\/)knox(?:\/|[._-]|$)/i,
    tier: 'restricted',
    description: 'Knox source path',
  },

  // --- Unreleased product and planning material ----------------------------
  {
    id: 'roadmap-doc',
    kind: 'path',
    pattern: /(?:roadmap|unreleased|confidential|internal[_-]?only|nda)/i,
    tier: 'confidential',
    description: 'Path suggests planning or confidential material',
  },
  {
    id: 'internal-marking',
    kind: 'content',
    pattern:
      /\b(?:SAMSUNG CONFIDENTIAL|COMPANY CONFIDENTIAL|INTERNAL USE ONLY|DO NOT DISTRIBUTE|PROPRIETARY AND CONFIDENTIAL)\b/i,
    tier: 'restricted',
    description: 'Carries an explicit confidentiality marking',
  },
]);

/** Builds the rule for project codenames, which are configuration, not code. */
export function codenameRule(codenames: string[]): PatternRule | undefined {
  const cleaned = codenames.map((c) => c.trim()).filter((c) => c.length >= 3);
  if (cleaned.length === 0) {
    return undefined;
  }
  const escaped = cleaned.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    id: 'codename',
    kind: 'content',
    pattern: new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i'),
    tier: 'confidential',
    description: 'Mentions an internal project codename',
  };
}

/**
 * Shannon entropy over a token. High-entropy strings that survive the named
 * patterns above are usually keys someone did not label as one.
 */
export function shannonEntropy(value: string): number {
  if (!value) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const HIGH_ENTROPY_CANDIDATE = /['"]([A-Za-z0-9+/=_-]{32,})['"]/g;
const ENTROPY_THRESHOLD = 4.2;

export function findHighEntropyStrings(content: string): string[] {
  const hits: string[] = [];
  for (const match of content.matchAll(HIGH_ENTROPY_CANDIDATE)) {
    const value = match[1] ?? '';
    // Hashes and base64 blobs in test fixtures trip this constantly, so require
    // both length and genuine randomness before calling it a secret.
    if (shannonEntropy(value) >= ENTROPY_THRESHOLD) {
      hits.push(value);
    }
  }
  return hits;
}

export interface PrefilterResult {
  tier: Tier;
  reasons: ClassificationReason[];
  /** True when a rule fired, meaning Gauss need not look at this file at all. */
  decided: boolean;
}

/**
 * Applies every rule to one file.
 *
 * Returns the *highest* tier any rule produced. Deliberately never downgrades:
 * a file that looks like both a roadmap and a bootloader is treated as a
 * bootloader.
 */
export function prefilter(
  path: string,
  content: string,
  rules: readonly PatternRule[] = DEFAULT_RULES,
): PrefilterResult {
  const reasons: ClassificationReason[] = [];
  let tier: Tier = 'public';

  const raise = (candidate: Tier, reason: ClassificationReason) => {
    reasons.push(reason);
    if (TIER_RANK[candidate] > TIER_RANK[tier]) {
      tier = candidate;
    }
  };

  for (const rule of rules) {
    const target = rule.kind === 'path' ? path : content;
    if (rule.pattern.test(target)) {
      raise(rule.tier, {
        signal: rule.kind === 'path' ? 'path-rule' : 'secret-scan',
        detail: rule.description,
        path,
      });
    }
  }

  const entropyHits = findHighEntropyStrings(content);
  if (entropyHits.length > 0) {
    raise('restricted', {
      signal: 'secret-scan',
      detail: `Contains ${entropyHits.length} high-entropy string${entropyHits.length === 1 ? '' : 's'} that may be credentials`,
      path,
    });
  }

  return { tier, reasons, decided: reasons.length > 0 };
}
