import type { AdapterId, Subtask, SubtaskKind, TokenEstimate } from '../types/ir.ts';
import type { PriceTable } from '../accounting/pricing.ts';
import { policyFor, scaleCap } from '../optimize/outputPolicy.ts';
import type { DraftSubtask, Difficulty } from './decompose.ts';

/**
 * Model routing.
 *
 * Deliberately deterministic — no model call. Two reasons. It is free, and
 * asking an LLM to decide would put planning overhead on the critical path of
 * every subtask. More importantly it is *auditable*: when a security reviewer
 * asks why a bootloader file went to Gauss, the answer is a rule they can read,
 * not a probability distribution.
 *
 * Precedence is strict and policy always beats cost:
 *
 *   1. Any file in the subtask not approved for external use  → Gauss. Final.
 *   2. Otherwise difficulty and kind select a cost tier.
 *   3. Within a tier, the first available adapter wins.
 *   4. Nothing available → Gauss, with a note.
 */

export interface ModelChoice {
  adapter: AdapterId;
  model: string;
}

export interface TierConfig {
  cheap: ModelChoice[];
  standard: ModelChoice[];
  frontier: ModelChoice[];
  gauss: ModelChoice;
}

/**
 * Preference order within each tier. First available wins, so put the model you
 * would rather use first. Overridable through `orchestrator.routing.tiers`.
 */
export const DEFAULT_TIERS: TierConfig = {
  cheap: [
    { adapter: 'claude', model: 'haiku' },
    { adapter: 'gemini', model: 'gemini-2.5-flash' },
    { adapter: 'codex', model: 'gpt-5-mini' },
  ],
  standard: [
    { adapter: 'claude', model: 'sonnet' },
    { adapter: 'codex', model: 'gpt-5' },
    { adapter: 'gemini', model: 'gemini-2.5-pro' },
  ],
  frontier: [
    { adapter: 'claude', model: 'opus' },
    { adapter: 'codex', model: 'gpt-5' },
    { adapter: 'gemini', model: 'gemini-2.5-pro' },
  ],
  gauss: { adapter: 'gauss', model: 'gauss' },
};

export type CostTier = 'cheap' | 'standard' | 'frontier';

/**
 * Difficulty dominates, kind adjusts.
 *
 * Review and refactor are promoted because a cheap model that misses a security
 * problem or mangles a refactor costs far more to clean up than the tokens it
 * saved. Docs are demoted for the mirror reason: a mediocre docstring is
 * cheap to fix.
 */
export function costTierFor(kind: SubtaskKind, difficulty: Difficulty): CostTier {
  if (difficulty === 'hard') {
    return 'frontier';
  }
  if (difficulty === 'mechanical') {
    return kind === 'review' || kind === 'refactor' ? 'standard' : 'cheap';
  }
  return kind === 'review' ? 'frontier' : 'standard';
}

export interface RoutingInput {
  drafts: DraftSubtask[];
  /** Paths that may NOT be sent to an external provider. */
  gaussOnlyPaths: Set<string>;
  /** Adapters the probe found usable this session. */
  availableAdapters: Set<AdapterId>;
  tiers?: TierConfig;
  prices: PriceTable;
  /** Tokens the shared IR prefix adds to every subtask. */
  sharedPrefixTokens: number;
  /** Bias routing toward faster models: frontier work drops to the standard tier. */
  preferFast?: boolean;
  /**
   * Pins every subtask to Gauss regardless of files or cost.
   *
   * Set when sensitive content entered the conversation itself rather than
   * through a file — a pasted excerpt, a codename in the prompt. Per-file
   * routing cannot help there, because the sensitive text is in the shared IR
   * prefix that every subtask carries.
   */
  forceGauss?: { reason: string };
}

export interface RoutingResult {
  subtasks: Subtask[];
  warnings: string[];
  /** Subtasks forced onto Gauss by policy, for the plan panel to highlight. */
  policyPinned: { id: string; paths: string[] }[];
}

export function route(input: RoutingInput): RoutingResult {
  const tiers = input.tiers ?? DEFAULT_TIERS;
  const warnings: string[] = [];
  const policyPinned: RoutingResult['policyPinned'] = [];
  const subtasks: Subtask[] = [];

  for (const draft of input.drafts) {
    const restricted = draft.context
      .map((ref) => ref.path)
      .filter((path) => input.gaussOnlyPaths.has(path));

    const contextTokens = draft.context.reduce((sum, ref) => sum + ref.estTokens, 0);
    const output = policyFor(draft.kind);
    output.maxTokens = scaleCap(output.maxTokens, contextTokens);

    let choice: ModelChoice;
    let routingNote: string | undefined;

    if (input.forceGauss) {
      // Rule 0. Outranks even the per-file check: the offending content is in
      // the prompt, so no choice of files makes any subtask safe to send.
      choice = tiers.gauss;
      routingNote = input.forceGauss.reason;
      policyPinned.push({ id: draft.id, paths: [] });
    } else if (restricted.length > 0) {
      // Rule 1. No cost consideration can override this.
      choice = tiers.gauss;
      routingNote = `Pinned to Gauss: ${restricted.length} file${restricted.length === 1 ? '' : 's'} not approved for external use (${restricted.slice(0, 3).join(', ')}${restricted.length > 3 ? ', …' : ''}).`;
      policyPinned.push({ id: draft.id, paths: restricted });
    } else {
      let tier = costTierFor(draft.kind, draft.difficulty);
      // Prefer-fast: run frontier work on the standard tier (sonnet-class), which
      // is markedly quicker than opus-class and strong enough for most analysis.
      if (input.preferFast && tier === 'frontier') {
        tier = 'standard';
        routingNote = 'prefer-fast: using the standard tier instead of frontier.';
      }
      const preferred = tiers[tier];
      const available = preferred.find((candidate) => input.availableAdapters.has(candidate.adapter));

      if (available) {
        choice = available;
        if (available !== preferred[0] && !routingNote) {
          routingNote = `${preferred[0]?.adapter} unavailable; using ${available.adapter} from the ${tier} tier.`;
        }
      } else {
        choice = tiers.gauss;
        routingNote = `No ${tier}-tier adapter is available, so this runs on Gauss. Quality may differ from the plan.`;
        warnings.push(`Subtask "${draft.id}" fell back to Gauss: no adapter available in the ${tier} tier.`);
      }
    }

    const estimate = estimateSubtask({
      contextTokens: contextTokens + input.sharedPrefixTokens,
      maxOutputTokens: output.maxTokens,
      model: choice.model,
      prices: input.prices,
    });

    subtasks.push({
      id: draft.id,
      dependsOn: draft.dependsOn,
      kind: draft.kind,
      goal: draft.goal,
      context: draft.context,
      consumes: draft.dependsOn,
      adapter: choice.adapter,
      model: choice.model,
      output,
      estimate,
      ...(routingNote ? { routingNote } : {}),
    });
  }

  return { subtasks, warnings, policyPinned };
}

/**
 * Forecast for the plan panel.
 *
 * Output is estimated at 60% of the cap rather than the cap itself: a schema-
 * constrained response usually lands well under its ceiling, and quoting the
 * ceiling would make every plan look more expensive than it is and push people
 * to skip the tool.
 */
function estimateSubtask(args: {
  contextTokens: number;
  maxOutputTokens: number;
  model: string;
  prices: PriceTable;
}): TokenEstimate {
  const inTokens = args.contextTokens;
  const outTokens = Math.round(args.maxOutputTokens * 0.6);
  return {
    inTokens,
    outTokens,
    usd: args.prices.cost(args.model, {
      inputTokens: inTokens,
      outputTokens: outTokens,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    }),
  };
}

export function totalEstimate(subtasks: Subtask[]): TokenEstimate {
  return subtasks.reduce<TokenEstimate>(
    (sum, subtask) => ({
      inTokens: sum.inTokens + subtask.estimate.inTokens,
      outTokens: sum.outTokens + subtask.estimate.outTokens,
      usd: sum.usd + subtask.estimate.usd,
    }),
    { inTokens: 0, outTokens: 0, usd: 0 },
  );
}

/**
 * Last line of defence, run immediately before dispatch.
 *
 * The router already guarantees this, but the check is cheap and the failure it
 * prevents is unrecoverable — once bytes reach a provider they cannot be
 * recalled. Anything that trips this is a bug, so it throws rather than warns.
 */
export function assertRoutingSafe(subtask: Subtask, gaussOnlyPaths: Set<string>): void {
  if (subtask.adapter === 'gauss') {
    return;
  }
  const leaking = subtask.context.map((ref) => ref.path).filter((path) => gaussOnlyPaths.has(path));
  if (leaking.length > 0) {
    throw new Error(
      `Refusing to dispatch subtask "${subtask.id}" to ${subtask.adapter}: ` +
        `${leaking.join(', ')} ${leaking.length === 1 ? 'is' : 'are'} not approved for external use.`,
    );
  }
}
