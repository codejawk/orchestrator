import type { ContextRef } from '../types/ir.ts';
import type { Planner } from './gauss.ts';

/**
 * Context selection: deciding what the executing model gets to see.
 *
 * This is the input-side counterpart to the output policy, and it is where the
 * design differs most from a conventional coding agent. Cline or Claude Code
 * would let a frontier model go exploring and then condense once the window
 * fills — reactive, and you have already paid by the time it triggers. Here
 * Gauss picks the file set up front and the executing CLI is denied its own
 * tools, so those exploration tokens are never spent.
 *
 * The bet is that Gauss can choose well from skeletons alone. If it cannot, we
 * trade answer quality for tokens, which is a bad trade — hence
 * `escalateToFull`, and hence the eval harness.
 */

export interface CandidateFile {
  path: string;
  /** Symbol outline from the language server. Costs no model tokens to make. */
  skeleton: string;
  /** Tokens the full file would cost, for the budget arithmetic. */
  fullTokens: number;
  skeletonTokens: number;
  /** False when the file is Gauss-only, which constrains routing downstream. */
  externalAllowed: boolean;
}

const SELECT_SYSTEM = `You choose which files a coding model needs to see, and how much of each.

For every file you include, pick a mode:
- "skeleton": signatures only. Enough to know an API exists and how to call it.
- "range": one specific region matters. Give start and end lines.
- "full": the model must read and modify the whole file.

Include as little as possible. A file the model does not need is pure cost, and too much context measurably degrades answers as well as inflating them. Most files that are merely referenced need "skeleton", not "full".

Only "full" or "range" files can be edited. If the task modifies a file, that file must be "full" or "range".

Give a "why" of at most 12 words per file.`;

const SELECT_SCHEMA = {
  name: 'context_selection',
  schema: {
    type: 'object',
    properties: {
      selected: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            mode: { type: 'string', enum: ['skeleton', 'range', 'full'] },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
            why: { type: 'string' },
          },
          required: ['path', 'mode', 'startLine', 'endLine', 'why'],
          additionalProperties: false,
        },
      },
    },
    required: ['selected'],
    additionalProperties: false,
  },
} as const;

interface RawSelection {
  selected: {
    path: string;
    mode: 'skeleton' | 'range' | 'full';
    startLine: number;
    endLine: number;
    why: string;
  }[];
}

export interface SelectionResult {
  refs: ContextRef[];
  /** Selected files that may not leave the network. Forces Gauss routing. */
  gaussOnlyPaths: string[];
  warnings: string[];
}

export interface SelectOptions {
  /** Hard ceiling on selected context. Over budget, the tail is dropped. */
  budgetTokens?: number;
  signal?: AbortSignal;
}

const DEFAULT_BUDGET_TOKENS = 30_000;

export async function selectContext(
  goal: string,
  candidates: CandidateFile[],
  gauss: Planner,
  options: SelectOptions = {},
): Promise<SelectionResult> {
  const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const warnings: string[] = [];

  if (candidates.length === 0) {
    return { refs: [], gaussOnlyPaths: [], warnings: ['No candidate files were available to select from.'] };
  }

  const byPath = new Map(candidates.map((c) => [c.path, c]));
  const inventory = candidates
    .map((c) => `<candidate path="${c.path}" fullTokens="${c.fullTokens}">\n${c.skeleton}\n</candidate>`)
    .join('\n\n');

  const result = await gauss.complete<RawSelection>({
    purpose: 'select-context',
    system: SELECT_SYSTEM,
    user: `Task:\n${goal}\n\nBudget: about ${budget} tokens of context.\n\nCandidates:\n${inventory}`,
    schema: SELECT_SCHEMA,
    maxTokens: 200 + candidates.length * 30,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  warnings.push(...result.warnings);

  if (!result.data) {
    // Falling back to "everything" would be the expensive failure and would
    // quietly undo the point of this module, so fall back to nothing and let
    // the caller surface it.
    warnings.push('Context selection failed to parse. No context selected; refine the request or retry.');
    return { refs: [], gaussOnlyPaths: [], warnings };
  }

  const refs: ContextRef[] = [];
  const gaussOnlyPaths: string[] = [];
  let spent = 0;

  for (const item of result.data.selected) {
    const candidate = byPath.get(item.path);
    if (!candidate) {
      warnings.push(`Selector named an unknown path "${item.path}"; ignored.`);
      continue;
    }

    const ref = toRef(item, candidate);
    if (spent + ref.estTokens > budget) {
      warnings.push(
        `Context budget of ${budget} tokens reached; dropped ${item.path} and anything after it.`,
      );
      break;
    }

    spent += ref.estTokens;
    refs.push(ref);
    if (!candidate.externalAllowed) {
      gaussOnlyPaths.push(candidate.path);
    }
  }

  return { refs, gaussOnlyPaths, warnings };
}

function toRef(
  item: RawSelection['selected'][number],
  candidate: CandidateFile,
): ContextRef {
  if (item.mode === 'skeleton') {
    return {
      path: candidate.path,
      mode: 'skeleton',
      estTokens: candidate.skeletonTokens,
      rationale: item.why,
    };
  }

  if (item.mode === 'range' && item.startLine > 0 && item.endLine >= item.startLine) {
    // Estimate the slice proportionally; the materializer measures for real.
    const fraction = Math.min(1, (item.endLine - item.startLine + 1) / 400);
    return {
      path: candidate.path,
      mode: 'range',
      range: [item.startLine, item.endLine],
      estTokens: Math.max(50, Math.round(candidate.fullTokens * fraction)),
      rationale: item.why,
    };
  }

  return {
    path: candidate.path,
    mode: 'full',
    estTokens: candidate.fullTokens,
    rationale: item.why,
  };
}

/**
 * Promotes a file to full content mid-run.
 *
 * Escalation on demand is what keeps skeleton-first honest: if a subtask
 * genuinely cannot proceed on signatures, it says so and we pay for the body
 * rather than letting it guess.
 */
export function escalateToFull(refs: ContextRef[], path: string, fullTokens: number): ContextRef[] {
  return refs.map((ref) =>
    ref.path === path
      ? { ...ref, mode: 'full' as const, range: undefined, estTokens: fullTokens }
      : ref,
  );
}

export function totalContextTokens(refs: ContextRef[]): number {
  return refs.reduce((sum, ref) => sum + ref.estTokens, 0);
}
