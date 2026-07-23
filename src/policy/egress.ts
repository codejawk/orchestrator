import { createHash } from 'node:crypto';
import type { Tier } from '../types/ir.ts';
import { TIER_RANK } from '../types/ir.ts';
import { prefilter, type PatternRule } from './patterns.ts';
import { redactSecrets } from './redact.ts';

/**
 * The egress chokepoint.
 *
 * Everything upstream — classification, approval, routing — is a decision, and
 * decisions have bugs. This is not a decision. It is a single function that
 * every byte bound for an external provider passes through, which re-inspects
 * the *exact serialized payload* one last time and hard-fails if anything
 * restricted is in it.
 *
 * The distinction the reviewer drew is the right one: a routing rule that says
 * "confidential goes to Gauss" can be wrong in a dozen ways — a mis-scan, a
 * stale approval, a taint that did not propagate, a subtask that pulled a file
 * through the ledger. This guard does not care how the bytes got here. It reads
 * what is actually about to leave and blocks on the content itself.
 *
 * It is deterministic and cheap: regexes over one string, no model call. That
 * is deliberate — the last line of defence must not depend on the weakest model
 * in the stack, or on the network being up.
 *
 * It only ever blocks. It cannot approve something the upstream stages denied,
 * and it is not a substitute for them; it is the backstop that makes their
 * correctness auditable in isolation.
 */

export interface EgressViolation {
  kind: 'secret' | 'tier' | 'marker';
  detail: string;
}

export interface EgressVerdict {
  allowed: boolean;
  /** Tier the deterministic scan assigned to the outbound bytes. */
  tier: Tier;
  violations: EgressViolation[];
  /** sha256 of the payload, for the audit record. Never the payload itself. */
  payloadHash: string;
}

export interface EgressOptions {
  rules?: readonly PatternRule[];
  /**
   * Block at this tier and above. `confidential` by default: anything the
   * deterministic scan rates confidential or restricted should have been
   * redacted or routed to Gauss before reaching here, so its presence in an
   * outbound payload is a bug we refuse to let ship.
   */
  blockAt?: Tier;
}

/**
 * Redaction placeholders that must never survive to egress. If the payload
 * still contains a `<SECRET_1>` marker, redaction ran but its output was not
 * used — a wiring bug that would send the *un*-redacted original if inverted,
 * so we treat a surviving marker as a hard block rather than a curiosity.
 */
const PLACEHOLDER = /<(?:PRIVATE_KEY|AWS_KEY|TOKEN|JWT|IMEI|MAC|EMAIL|ANDROID_ID|SERIAL|SECRET)_\d+>/;

export class EgressGuard {
  private readonly rules: readonly PatternRule[] | undefined;
  private readonly blockAt: Tier;

  constructor(options: EgressOptions = {}) {
    this.rules = options.rules;
    this.blockAt = options.blockAt ?? 'confidential';
  }

  /**
   * Inspects the exact string about to be sent. `parts` are joined the same way
   * the adapter will assemble them, so the guard sees precisely what leaves —
   * system prompt, user prompt, and anything else in the request.
   */
  inspect(parts: string[]): EgressVerdict {
    const payload = parts.filter(Boolean).join('\n');
    const violations: EgressViolation[] = [];

    // 1. Raw structured secrets. redactSecrets reports what it *would* strip; if
    //    anything is here, an un-redacted credential is in the outbound bytes.
    const secrets = redactSecrets(payload).redactions;
    for (const secret of dedupeByRule(secrets)) {
      violations.push({ kind: 'secret', detail: `payload contains a ${secret.rule}` });
    }

    // 2. Tier of the actual content. Catches a restricted file that reached the
    //    payload through any path the router did not foresee.
    const pre = prefilter('<egress>', payload, this.rules);
    if (TIER_RANK[pre.tier] >= TIER_RANK[this.blockAt]) {
      const reason = pre.reasons[0]?.detail ?? 'classified content';
      violations.push({ kind: 'tier', detail: `payload reads as ${pre.tier}: ${reason}` });
    }

    // 3. A surviving redaction placeholder means the redaction pipeline is
    //    mis-wired. Fail loudly rather than guess which way it broke.
    if (PLACEHOLDER.test(payload)) {
      violations.push({
        kind: 'marker',
        detail: 'payload still contains a redaction placeholder; the redaction output was not applied',
      });
    }

    return {
      allowed: violations.length === 0,
      tier: pre.tier,
      violations,
      payloadHash: sha256Hex(payload),
    };
  }
}

function dedupeByRule(secrets: { rule: string }[]): { rule: string }[] {
  const seen = new Set<string>();
  const out: { rule: string }[] = [];
  for (const secret of secrets) {
    if (!seen.has(secret.rule)) {
      seen.add(secret.rule);
      out.push(secret);
    }
  }
  return out;
}

/** sha256 as hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
