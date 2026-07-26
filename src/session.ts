import { SessionTaint, type PromptAssessment } from './planner/promptGuard.ts';
import { restore, type Redaction } from './policy/redact.ts';
import type { ContextRef, ExecutionPlan, Tier } from './types/ir.ts';
import type { CandidateFile } from './planner/contextSelector.ts';
import type { ClarificationAnswer, IntakeOutcome } from './planner/intake.ts';
import type { ScanReport } from './planner/scanner.ts';
import type { ExecutionOutcome } from './exec/runner.ts';
import type { WorkspaceFile } from './workspace.ts';

/**
 * A conversation, not a single request.
 *
 * Lives in its own module — free of vscode — so the whole conversation contract
 * can be tested outside the extension host, and so the pieces that persist
 * across turns are defined in one place rather than tangled into the pipeline.
 */

/** One completed exchange, kept so later turns in the same chat have context. */
export interface ConversationTurn {
  goal: string;
  /** One line: what happened. Never raw output — a summary, cheap to resend. */
  summary: string;
}

/**
 * The workspace scan, the accumulated taint, the redaction map and the turn
 * history all live for the life of the chat, so a follow-up like "now check the
 * fuel gauge too" reuses the expensive scan and knows what came before. Only the
 * per-turn fields — the current prompt, intake, plan, outcome — reset each turn.
 *
 * Taint accumulating across the whole conversation is the security-critical part
 * of this: chat history is context, and if turn 2 pasted something confidential,
 * turn 9 must still be pinned to Gauss. `SessionTaint` is already sticky; keeping
 * one instance for the conversation is what makes that hold across turns.
 */
export class OrchestratorSession {
  readonly id: string;
  readonly taint = new SessionTaint();

  // -- Conversation-lifetime state (survives across turns) ------------------
  files: WorkspaceFile[] = [];
  /** Verdicts from the free regex sweep, for every file in the workspace. */
  sweep = new Map<string, { tier: Tier; reasons: { signal: string; detail: string }[] }>();
  candidates: CandidateFile[] = [];
  /** Redactions from every turn, so reveal() works on any turn's output. */
  redactions: Redaction[] = [];
  /** Prior exchanges, oldest first. Fed to the compiler as a compact summary. */
  turns: ConversationTurn[] = [];
  /** Files the sweep could not read (too large, binary), for honest messaging. */
  sweepSkipped: { path: string; reason: string }[] = [];

  // -- Per-turn state (reset by startTurn) ----------------------------------
  originalPrompt = '';
  guardedPrompt = '';
  assessment?: PromptAssessment;
  intake?: IntakeOutcome;
  answers: ClarificationAnswer[] = [];
  selectedRefs?: ContextRef[];
  scan?: ScanReport;
  plan?: ExecutionPlan;
  outcome?: ExecutionOutcome;
  /** The combined answer produced by the synthesis step (your step 6). */
  synthesis?: string;

  constructor(id: string) {
    this.id = id;
  }

  /** True before the workspace has been swept even once. */
  get needsSweep(): boolean {
    return this.files.length === 0;
  }

  /**
   * Resets per-turn state for a follow-up while keeping the workspace scan,
   * the taint, the redaction map and the turn history.
   */
  startTurn(): void {
    this.originalPrompt = '';
    this.guardedPrompt = '';
    this.assessment = undefined;
    this.intake = undefined;
    this.answers = [];
    this.selectedRefs = undefined;
    this.scan = undefined;
    this.plan = undefined;
    this.outcome = undefined;
    this.synthesis = undefined;
  }

  /** Records the outcome of a finished turn for later turns to build on. */
  recordTurn(summary: string): void {
    this.turns.push({ goal: this.intake?.restatedGoal || this.originalPrompt, summary });
  }

  /**
   * A compact recap of the conversation so far, for the compiler.
   *
   * Summaries, never transcripts — the same discipline the ledger uses between
   * subtasks. Resending full prior turns would grow context without bound; a
   * line per turn is enough for Gauss to keep the thread. Capped at the most
   * recent handful so a long chat cannot inflate every later prompt.
   */
  priorContext(): string {
    if (this.turns.length === 0) {
      return '';
    }
    const recent = this.turns.slice(-6);
    return [
      'CONVERSATION SO FAR (most recent last):',
      ...recent.map((turn, i) => `${i + 1}. asked: ${turn.goal}\n   result: ${turn.summary}`),
    ].join('\n');
  }

  /** Puts redacted identifiers back before anything is shown to the user. */
  reveal(text: string): string {
    return restore(text, this.redactions);
  }
}
