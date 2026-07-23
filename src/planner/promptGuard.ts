import type { ClassificationReason, Tier } from '../types/ir.ts';
import { TIER_RANK } from '../types/ir.ts';
import { prefilter, type PatternRule } from '../policy/patterns.ts';
import { redactSecrets, type RedactionResult } from '../policy/redact.ts';

/**
 * Guards text the user typed or pasted, before it can reach anything.
 *
 * The file-approval gate covers files. It does not cover the chat box, and the
 * chat box is where a developer pastes the dumpstate, the crash trace, the
 * snippet from the internal wiki. That text flows into the compiled IR and from
 * there into every external subtask, so it needs the same treatment.
 *
 * Two mechanisms, because one is not enough:
 *
 *   1. **Redaction** removes structured identifiers — IMEIs, serials, tokens.
 *      Deterministic, reversible, and the text stays usable afterwards.
 *   2. **Tainting** handles what redaction cannot touch. "The Nightfall launch
 *      slipped" has no pattern to strip; you either send that sentence or you
 *      do not. So the whole run pins to Gauss.
 *
 * Tainting is sticky for the conversation, not just the turn. Chat history is
 * resent, so a session that saw restricted content in turn 3 is still carrying
 * it in turn 12 — re-evaluating per turn would leak on the next message.
 */

export interface PromptAssessment {
  /** Prompt with structured identifiers replaced. Use this, not the original. */
  redaction: RedactionResult;
  tier: Tier;
  reasons: ClassificationReason[];
  /** True when this run must be pinned to Gauss whatever the file approvals say. */
  taint: boolean;
  /** Shown to the user so the redaction is never silent. */
  summary: string;
}

export interface AssessOptions {
  rules?: readonly PatternRule[];
  /**
   * Tier at which a run is forced onto Gauss. `confidential` by default: prose
   * about unreleased work is exactly the thing redaction cannot fix.
   */
  taintAt?: Tier;
}

export function assessPrompt(text: string, options: AssessOptions = {}): PromptAssessment {
  const taintAt = options.taintAt ?? 'confidential';
  const redaction = redactSecrets(text);

  // Prefilter the REDACTED text. Running it on the original would re-detect the
  // credentials we just removed and taint every run that pasted a log, which
  // would make the feature so annoying people would stop pasting logs — and
  // start pasting them into a browser tab instead.
  const pre = prefilter('<chat input>', redaction.text, options.rules);

  const reasons: ClassificationReason[] = pre.reasons.map((reason) => ({
    ...reason,
    path: undefined,
    detail: `Chat input: ${reason.detail}`,
  }));

  if (redaction.redactions.length > 0) {
    reasons.push({
      signal: 'secret-scan',
      detail: `Redacted ${redaction.redactions.length} identifier${redaction.redactions.length === 1 ? '' : 's'} from your message before use`,
    });
  }

  const taint = TIER_RANK[pre.tier] >= TIER_RANK[taintAt];

  return {
    redaction,
    tier: pre.tier,
    reasons,
    taint,
    summary: buildSummary(pre.tier, redaction, taint),
  };
}

function buildSummary(tier: Tier, redaction: RedactionResult, taint: boolean): string {
  const parts: string[] = [];

  if (redaction.redactions.length > 0) {
    parts.push(
      `Removed ${redaction.redactions.length} identifier${redaction.redactions.length === 1 ? '' : 's'} (${redaction.rulesFired.join(', ')}) from your message. ` +
        'They are restored in the results you see, but no external model receives them.',
    );
  }
  if (taint) {
    parts.push(
      `Your message reads as ${tier}, and that is not something redaction can strip. ` +
        'This entire run stays on Gauss.',
    );
  }
  return parts.join(' ');
}

/**
 * Accumulates taint across a conversation.
 *
 * Deliberately one-way: once a session is tainted it stays tainted until the
 * user starts a new one. A "clean" turn does not clear it, because the earlier
 * content is still in the history that gets resent.
 */
export class SessionTaint {
  private tainted = false;
  private readonly reasons: string[] = [];

  get isTainted(): boolean {
    return this.tainted;
  }

  get explanation(): string {
    return this.reasons.join(' ');
  }

  absorb(assessment: PromptAssessment): void {
    if (!assessment.taint) {
      return;
    }
    this.tainted = true;
    if (assessment.summary) {
      this.reasons.push(assessment.summary);
    }
  }

  /** Called when a scan finds restricted content among the selected files. */
  taintBecause(reason: string): void {
    this.tainted = true;
    this.reasons.push(reason);
  }
}
