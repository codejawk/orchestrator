import type { Classification, ContextRef, PromptIR } from '../types/ir.ts';
import { estimateTokens } from '../optimize/tokens.ts';
import type { GaussClient } from './gauss.ts';

/**
 * The prompt compiler.
 *
 * Turns a paragraph of English plus a pile of clarification answers into a
 * small explicit structure. Two things come out of that, and only one of them
 * is token count.
 *
 * The obvious win: a compiled IR is shorter than the conversation that produced
 * it, and it is what gets resent on every subtask rather than the whole
 * exchange.
 *
 * The less obvious win: `nonGoals`. Naming what is out of scope measurably cuts
 * output tokens, because the main way a coding model runs long is volunteering
 * adjacent work nobody asked for. Telling it what not to do is cheaper than
 * paying for what it does.
 */

const COMPILE_SYSTEM = `You compile a developer's request into a compact specification.

- goal: one sentence, imperative, naming the concrete change.
- constraints: things the implementation must respect — existing APIs, style, compatibility, performance. Only real constraints from the request or the code, never invented ones.
- acceptance: testable statements that are true when the work is done. Prefer things a test could assert.
- nonGoals: adjacent work a model might reasonably volunteer that is NOT wanted here. This is important — be specific and list two to five.

Be terse. Every word is resent on every subsequent call. Do not restate the request.`;

const COMPILE_SCHEMA = {
  name: 'prompt_ir',
  schema: {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      constraints: { type: 'array', items: { type: 'string' } },
      acceptance: { type: 'array', items: { type: 'string' } },
      nonGoals: { type: 'array', items: { type: 'string' } },
    },
    required: ['goal', 'constraints', 'acceptance', 'nonGoals'],
    additionalProperties: false,
  },
} as const;

interface RawIR {
  goal: string;
  constraints: string[];
  acceptance: string[];
  nonGoals: string[];
}

export interface CompileResult {
  ir: PromptIR;
  warnings: string[];
  /** Tokens in, tokens out. Drives the "prompt compressed by N%" line. */
  compression: { before: number; after: number; ratio: number };
}

export async function compilePrompt(
  mergedPrompt: string,
  context: ContextRef[],
  classification: Classification,
  gauss: GaussClient,
  signal?: AbortSignal,
): Promise<CompileResult> {
  const warnings: string[] = [];
  const rawPromptTokens = estimateTokens(mergedPrompt);

  const contextSummary = context
    .map((ref) => `- ${ref.path} (${ref.mode})${ref.rationale ? `: ${ref.rationale}` : ''}`)
    .join('\n');

  const result = await gauss.complete<RawIR>({
    purpose: 'compile',
    system: COMPILE_SYSTEM,
    user: `${mergedPrompt}\n\nContext that will be provided:\n${contextSummary || '(none)'}`,
    schema: COMPILE_SCHEMA,
    maxTokens: 700,
    ...(signal ? { signal } : {}),
  });

  warnings.push(...result.warnings);

  // Compilation failing is recoverable: the uncompiled prompt still works, it
  // just costs more. Losing the request entirely would not be recoverable.
  const data = result.data ?? {
    goal: mergedPrompt.split('\n')[0]?.slice(0, 200) ?? mergedPrompt.slice(0, 200),
    constraints: [],
    acceptance: [],
    nonGoals: [],
  };
  if (!result.data) {
    warnings.push('Prompt compilation failed to parse; falling back to the raw prompt. This costs more tokens than a compiled IR.');
  }
  if (data.nonGoals.length === 0) {
    warnings.push('No non-goals were identified, so output may include unrequested work.');
  }

  const ir: PromptIR = {
    goal: data.goal.trim(),
    constraints: dedupe(data.constraints),
    acceptance: dedupe(data.acceptance),
    nonGoals: dedupe(data.nonGoals),
    context,
    classification,
    rawPromptTokens,
  };

  const after = estimateTokens(renderIR(ir));
  return {
    ir,
    warnings,
    compression: {
      before: rawPromptTokens,
      after,
      ratio: rawPromptTokens > 0 ? 1 - after / rawPromptTokens : 0,
    },
  };
}

/**
 * The wire format sent to executing models.
 *
 * Ordered static-first so the provider prompt cache sees a stable prefix across
 * subtasks: goal and constraints rarely change between subtasks of one plan,
 * while the subtask-specific tail does. Reordering this function will silently
 * cost cache hits, so it is deliberately the only place the layout is decided.
 */
export function renderIR(ir: PromptIR, subtaskGoal?: string): string {
  const lines: string[] = [`GOAL: ${ir.goal}`];

  if (ir.constraints.length > 0) {
    lines.push('', 'CONSTRAINTS:', ...ir.constraints.map((c) => `- ${c}`));
  }
  if (ir.acceptance.length > 0) {
    lines.push('', 'DONE WHEN:', ...ir.acceptance.map((a) => `- ${a}`));
  }
  if (ir.nonGoals.length > 0) {
    lines.push('', 'DO NOT:', ...ir.nonGoals.map((n) => `- ${n}`));
  }
  if (subtaskGoal) {
    lines.push('', `YOUR SUBTASK: ${subtaskGoal}`);
  }
  return lines.join('\n');
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}
