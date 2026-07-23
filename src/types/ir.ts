/**
 * The shared vocabulary for the whole extension.
 *
 * Stage 1 (planner/) turns a rambling user prompt plus a workspace into a
 * `PromptIR` and then an `ExecutionPlan`. Stage 2 (exec/) consumes the plan.
 * Nothing here imports vscode, so the planner and the eval harness can both
 * use it outside the extension host.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Data classification. Drives routing, and routing fails closed: anything at
 * `confidential` or above never reaches an external provider.
 */
export type Tier = 'public' | 'internal' | 'confidential' | 'restricted';

/** Ordered so comparisons like `rank(tier) >= rank('confidential')` work. */
export const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
});

export function isExternallyRoutable(tier: Tier): boolean {
  return TIER_RANK[tier] < TIER_RANK.confidential;
}

/** Why a classification decision was made, so the plan panel can explain it. */
export interface ClassificationReason {
  /** Which signal fired: path rule, secret scan, codename dictionary, model. */
  signal: 'path-rule' | 'secret-scan' | 'pii-scan' | 'codename' | 'model' | 'session-taint';
  detail: string;
  /** Path the signal fired on, when it was file-scoped. */
  path?: string;
}

export interface Classification {
  tier: Tier;
  reasons: ClassificationReason[];
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * How much of a file a subtask actually receives.
 *
 * `skeleton` is the cheap default: symbol signatures pulled from the language
 * server, which costs no model tokens to produce. Escalate to `range` or
 * `full` only when a subtask genuinely needs bodies.
 */
export type ContextMode = 'skeleton' | 'range' | 'full';

export interface ContextRef {
  /** Workspace-relative path. */
  path: string;
  mode: ContextMode;
  /** 1-indexed inclusive line bounds. Required when mode is 'range'. */
  range?: [number, number];
  /** Estimated tokens this ref contributes once materialized. */
  estTokens: number;
  /** Why the selector included this file. Shown in the plan panel. */
  rationale?: string;
}

/** A materialized context ref: the text that will actually be sent. */
export interface MaterializedContext {
  ref: ContextRef;
  text: string;
  /** Tokens after deterministic pre-compression, measured not estimated. */
  tokens: number;
}

// ---------------------------------------------------------------------------
// PromptIR — the compression artifact
// ---------------------------------------------------------------------------

/**
 * The compiled form of a user request. Producing this is the entire point of
 * Stage 1: a vague paragraph plus a repo becomes a small, explicit structure.
 *
 * `nonGoals` earns its place. Naming what is out of scope measurably reduces
 * output tokens, because it stops the model volunteering adjacent work.
 */
export interface PromptIR {
  goal: string;
  constraints: string[];
  /** Testable criteria. Doubles as the cascade's escalation check. */
  acceptance: string[];
  nonGoals: string[];
  context: ContextRef[];
  classification: Classification;
  /** Tokens in the user's original prompt plus anything they pasted. */
  rawPromptTokens: number;
}

// ---------------------------------------------------------------------------
// Clarification
// ---------------------------------------------------------------------------

export interface ClarificationQuestion {
  id: string;
  question: string;
  /** Suggested answers. Free-text is always permitted alongside these. */
  options?: string[];
  /** What stays unknown if this goes unanswered, and what we assume instead. */
  assumptionIfSkipped: string;
}

export interface IntakeResult {
  /** 0 = fully specified, 1 = hopelessly vague. */
  ambiguityScore: number;
  /** Empty when the prompt is clear enough to compile directly. */
  questions: ClarificationQuestion[];
  /**
   * True when the request is small enough that orchestrating it would cost
   * more than it saves. The fast path skips straight to a single model.
   */
  fastPath: boolean;
}

// ---------------------------------------------------------------------------
// Subtasks and plans
// ---------------------------------------------------------------------------

export type SubtaskKind =
  | 'analyze'
  | 'edit'
  | 'test'
  | 'review'
  | 'doc'
  | 'refactor';

export type AdapterId = 'claude' | 'codex' | 'gemini' | 'gauss';

export type OutputFormat = 'diff' | 'json' | 'prose';

/**
 * The output contract for a subtask. This is where most of the output-token
 * saving comes from: a schema plus a hard cap removes preamble, restatement
 * and unsolicited summary.
 */
export interface OutputPolicy {
  format: OutputFormat;
  maxTokens: number;
  /** JSON Schema passed to `--json-schema` / `--output-schema`. */
  schema?: object;
  /** Reasoning budget. Off for mechanical work, high only for debugging. */
  reasoning: 'off' | 'low' | 'medium' | 'high';
}

export interface TokenEstimate {
  inTokens: number;
  outTokens: number;
  usd: number;
}

export interface Subtask {
  id: string;
  /** IDs of subtasks that must complete first. Must form a DAG. */
  dependsOn: string[];
  kind: SubtaskKind;
  goal: string;
  /** This subtask's slice only — never the union of everything selected. */
  context: ContextRef[];
  /** Ledger entry IDs whose artifacts feed into this subtask. */
  consumes: string[];
  adapter: AdapterId;
  model: string;
  output: OutputPolicy;
  estimate: TokenEstimate;
  /** Set when the router overrode a cheaper choice because of policy. */
  routingNote?: string;
}

export interface ExecutionPlan {
  id: string;
  createdAt: string;
  ir: PromptIR;
  subtasks: Subtask[];
  /** Sum of per-subtask estimates, plus the Gauss planning cost already spent. */
  estimate: TokenEstimate;
  /** Gauss tokens already consumed producing this plan. Never hidden. */
  planningCost: CostRecord;
}

// ---------------------------------------------------------------------------
// Ledger — how subtasks hand off to each other
// ---------------------------------------------------------------------------

/**
 * Subtasks pass structured artifacts, never raw transcripts. Concatenating
 * transcripts makes context grow quadratically across a chain; a ledger keeps
 * it linear and small.
 */
export type ArtifactKind = 'diff' | 'finding' | 'decision' | 'symbol' | 'note';

export interface LedgerEntry {
  id: string;
  producedBy: string;
  kind: ArtifactKind;
  /** One line. Long enough to be useful downstream, short enough to be cheap. */
  summary: string;
  /** Full payload — a diff body, a JSON finding. Passed only when consumed. */
  body?: string;
  /** `file:line` references rather than quoted code. */
  refs: string[];
  tokens: number;
}

export interface Ledger {
  entries: LedgerEntry[];
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

/**
 * Normalized usage across three CLIs with three different output shapes.
 * `cachedInputTokens` is tracked separately because it is how we verify that
 * prompt-cache preservation is actually working rather than assume it.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Cache writes, where the provider reports them separately. */
  cacheCreationTokens: number;
}

export const ZERO_USAGE: Readonly<Usage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
});

export interface CostRecord {
  adapter: AdapterId;
  model: string;
  usage: Usage;
  usd: number;
  /**
   * True when the provider reported cost directly (Claude's `total_cost_usd`)
   * rather than us deriving it from the price table. Derived costs drift when
   * the table is stale; the report distinguishes them.
   */
  usdReported: boolean;
  durationMs: number;
}

/** Everything one orchestrated run actually spent, planning included. */
export interface RunAccounting {
  planId: string;
  /** Gauss calls: intake, clarify, select, compile, decompose, route, synth. */
  planning: CostRecord[];
  /** One per executed subtask. */
  execution: CostRecord[];
}

// ---------------------------------------------------------------------------
// Savings
// ---------------------------------------------------------------------------

/**
 * A savings figure needs a counterfactual, and we cannot know the naive cost
 * without measuring it. So the report always carries its own provenance:
 * `actual` is exact, `baseline` is explicitly an estimate until a true A/B
 * run replaces it.
 */
export interface SavingsReport {
  planId: string;
  /** Exact, summed from provider output. Includes Gauss planning overhead. */
  actualUsd: number;
  actualUsage: Usage;
  baseline: BaselineEstimate;
  netUsd: number;
  /** netUsd / baseline.usd, or 0 when the baseline is zero. */
  netFraction: number;
}

export interface BaselineEstimate {
  usd: number;
  usage: Usage;
  model: string;
  source: 'modeled' | 'measured';
  /**
   * Exploration multiplier: how much context a naive agentic run pulls in
   * beyond the files actually needed. Calibrated from sampled A/B runs.
   */
  explorationMultiplier: number;
  /** Sample size behind the current multiplier. 0 means uncalibrated. */
  calibrationSamples: number;
  calibratedAt?: string;
}
