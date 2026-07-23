import type { AdapterId, CostRecord, OutputPolicy, Subtask } from '../../types/ir.ts';

/**
 * Capabilities an adapter needs in order to do its job cheaply.
 *
 * These are not cosmetic. `stripsAgentContext` and `restrictTools` are the two
 * that carry the token savings: without them the CLI loads its own project
 * context and then explores the repo on its own, which silently undoes every
 * optimization the planner made upstream.
 */
export interface AdapterCapabilities {
  /** Non-interactive invocation at all. Without this the adapter is unusable. */
  headless: boolean;
  /** Machine-readable output we can meter. */
  structuredOutput: boolean;
  /** Schema-constrained final answer — the main output-token lever. */
  outputSchema: boolean;
  /** Can drop the CLI's own system prompt, memory files and MCP discovery. */
  stripsAgentContext: boolean;
  /** Can be denied tools so it cannot go exploring on its own. */
  restrictTools: boolean;
  /** Can be pinned to a specific model. */
  modelSelection: boolean;
  /** Can be scoped to a directory subset. */
  scopeDirs: boolean;
  /** Can resume a prior session, which preserves the provider prompt cache. */
  resume: boolean;
  /** Reports token usage we can read. */
  reportsUsage: boolean;
}

export const NO_CAPABILITIES: Readonly<AdapterCapabilities> = Object.freeze({
  headless: false,
  structuredOutput: false,
  outputSchema: false,
  stripsAgentContext: false,
  restrictTools: false,
  modelSelection: false,
  scopeDirs: false,
  resume: false,
  reportsUsage: false,
});

export type ProbeStatus = 'ready' | 'degraded' | 'unavailable';

export interface ProbeResult {
  adapter: AdapterId;
  status: ProbeStatus;
  /** Resolved binary path or command name that was probed. */
  bin: string;
  version?: string;
  capabilities: AdapterCapabilities;
  /**
   * Human-readable reasons the adapter is degraded or unavailable. Surfaced
   * verbatim in the status view — a silent capability loss shows up later as
   * an unexplained cost increase, which is far harder to diagnose.
   */
  notes: string[];
  probedAt: string;
}

export interface RunRequest {
  subtask: Subtask;
  /** Fully materialized prompt text. The planner has already compressed it. */
  prompt: string;
  /** System prompt replacing the CLI's default, where supported. */
  systemPrompt?: string;
  output: OutputPolicy;
  cwd: string;
  /** Directories the run may read. Kept as tight as the subtask allows. */
  scopeDirs: string[];
  /**
   * Environment for the child process. The extension never holds a provider
   * key — the CLIs authenticate themselves — but the extension host may not
   * carry the shell profile that defines them, so callers can inject.
   */
  env?: NodeJS.ProcessEnv;
  /** Prior session to resume, to keep the provider prompt cache warm. */
  resumeSessionId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export interface RunResult {
  ok: boolean;
  /** Final answer text, or the raw body when the schema was honoured. */
  text: string;
  /** Parsed structured output when an output schema was requested. */
  structured?: unknown;
  cost: CostRecord;
  sessionId?: string;
  /** Non-fatal problems: metering gaps, schema fallbacks, truncation. */
  warnings: string[];
  error?: string;
  /**
   * When `ok` is false, what kind of failure. `infra` — the CLI could not be
   * spawned or timed out; these trip the circuit breaker. `model` — the model
   * ran but produced an error or a bad answer; retrying elsewhere would not
   * help and it must not take a healthy adapter out of rotation.
   */
  failureKind?: 'infra' | 'model';
}

export interface ModelAdapter {
  readonly id: AdapterId;
  /** Cheap liveness and capability check. Must never throw. */
  probe(): Promise<ProbeResult>;
  run(request: RunRequest): Promise<RunResult>;
}
