/** The shared vocabulary of the orchestrator. Deliberately tiny. */

export type Difficulty = 'mechanical' | 'standard' | 'hard';
export type Kind = 'code' | 'test' | 'docs' | 'analysis' | 'review';
export type Adapter = 'claude' | 'codex';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface ModelChoice {
  adapter: Adapter;
  model: string;
  effort: Effort;
  reason: string;
}

/** One unit of work the main model carved out of the request. */
export interface Subtask {
  id: string;
  title: string;
  /** What this subtask must produce. */
  goal: string;
  kind: Kind;
  difficulty: Difficulty;
  /** ids of subtasks whose output this one needs. */
  dependsOn: string[];
  /** Assigned by the routing algorithm. */
  adapter: Adapter;
  model: string;
  effort: Effort;
  /** Why this model — shown in the plan so the choice is legible. */
  routingNote: string;
}

/** The plan the user confirms before anything runs. */
export interface Plan {
  prompt: string;
  subtasks: Subtask[];
}

/** The result of running one subtask on its assigned model. */
export interface SubtaskResult {
  id: string;
  ok: boolean;
  text: string;
  adapter: Adapter;
  model: string;
  effort: Effort;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  usd: number;
  error?: string;
}

export interface WrittenArtifact {
  label: string;
  path: string;
  kind: 'generated' | 'raw';
}
