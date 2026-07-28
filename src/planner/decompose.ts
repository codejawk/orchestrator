import type { ContextRef, PromptIR, SubtaskKind } from '../types/ir.ts';
import type { Planner } from './gauss.ts';

/**
 * Decomposition: splitting one request into subtasks that different models can
 * run, some in parallel.
 *
 * The value is not parallelism, it is *routing granularity*. A single request
 * usually contains one genuinely hard part and several mechanical ones. Kept
 * whole, all of it runs on a frontier model. Split, the mechanical parts drop
 * to a cheap tier and only the hard part pays frontier prices.
 *
 * Splitting has a cost of its own — each subtask carries its own prompt
 * overhead — so over-decomposition loses money. The prompt pushes toward few,
 * meaty subtasks rather than many small ones.
 */

const DECOMPOSE_SYSTEM = `You split a coding task into subtasks that can be assigned to different models.

Rules:
- Produce between 1 and 6 subtasks. Prefer fewer. One subtask is a perfectly good answer for a focused task.
- If the task is to write new, standalone code that does not depend on existing files (e.g. "write a binary search function"), produce ONE subtask and reference NO files. Do NOT add a separate "inspect" or "read the existing file" subtask — self-contained generation needs no file to read.
- Only reference a file if the subtask genuinely must read or change that specific file. Never invent a dependency on an unrelated file.
- Each subtask must be independently checkable.
- Set dependsOn only for real ordering constraints. Anything independent should run in parallel. Do not make a "provide code" subtask depend on an "inspect" subtask unless the code truly cannot be written without reading that file first.
- Mark difficulty honestly:
  - "mechanical": pattern-following with no real design choice — renames, boilerplate, docstrings, straightforward tests.
  - "standard": ordinary implementation work requiring care but no deep reasoning.
  - "hard": debugging, concurrency, security, performance, or a design decision with real consequences.
- Difficulty drives model cost. Marking everything "hard" wastes money; marking a genuinely hard subtask "mechanical" produces a wrong answer that costs more to fix than it saved.

kind must be one of: analyze, edit, test, review, doc, refactor.
- Writing NEW code that should be saved as a file ("write a C++ file that solves X", "create a script") is kind "edit" — the executor writes it to disk as a new file. A "solve this problem and create a file" request is typically ONE "edit" subtask referencing no existing files.
- Use "doc" only for prose explanations shown to the user, never for code that should become a file.
Only assign a file to a subtask if that subtask genuinely needs it.`;

const DECOMPOSE_SCHEMA = {
  name: 'decomposition',
  schema: {
    type: 'object',
    properties: {
      subtasks: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            goal: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['analyze', 'edit', 'test', 'review', 'doc', 'refactor'],
            },
            difficulty: { type: 'string', enum: ['mechanical', 'standard', 'hard'] },
            paths: { type: 'array', items: { type: 'string' } },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'goal', 'kind', 'difficulty', 'paths', 'dependsOn'],
          additionalProperties: false,
        },
      },
    },
    required: ['subtasks'],
    additionalProperties: false,
  },
} as const;

export type Difficulty = 'mechanical' | 'standard' | 'hard';

export interface DraftSubtask {
  id: string;
  goal: string;
  kind: SubtaskKind;
  difficulty: Difficulty;
  context: ContextRef[];
  dependsOn: string[];
}

export interface DecomposeResult {
  drafts: DraftSubtask[];
  warnings: string[];
}

export async function decompose(
  ir: PromptIR,
  gauss: Planner,
  signal?: AbortSignal,
): Promise<DecomposeResult> {
  const warnings: string[] = [];
  const available = new Map(ir.context.map((ref) => [ref.path, ref]));

  const fileList = ir.context
    .map((ref) => `- ${ref.path} (${ref.mode})${ref.rationale ? `: ${ref.rationale}` : ''}`)
    .join('\n');

  const result = await gauss.complete<{ subtasks: RawSubtask[] }>({
    purpose: 'decompose',
    system: DECOMPOSE_SYSTEM,
    user: [
      `GOAL: ${ir.goal}`,
      ir.constraints.length ? `CONSTRAINTS:\n${ir.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      ir.acceptance.length ? `DONE WHEN:\n${ir.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
      `AVAILABLE FILES:\n${fileList || '(none)'}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    schema: DECOMPOSE_SCHEMA,
    maxTokens: 900,
    ...(signal ? { signal } : {}),
  });

  warnings.push(...result.warnings);

  if (!result.data || result.data.subtasks.length === 0) {
    // A single subtask over the whole context is the safe degradation: it still
    // works, it just forgoes the routing saving.
    warnings.push('Decomposition failed; falling back to one subtask covering the whole request.');
    return {
      drafts: [
        {
          id: 'whole',
          goal: ir.goal,
          kind: 'edit',
          difficulty: 'standard',
          context: ir.context,
          dependsOn: [],
        },
      ],
      warnings,
    };
  }

  const ids = new Set(result.data.subtasks.map((s) => s.id));
  const drafts: DraftSubtask[] = result.data.subtasks.map((raw) => {
    // The planner often echoes an absolute path (/Users/…/hello.c) while the
    // context is keyed by the workspace-relative path (hello.c). Resolve by
    // suffix/basename so a named file is not wrongly "dropped".
    const context = raw.paths
      .map((path) => resolvePath(path, available))
      .filter((ref): ref is ContextRef => ref !== undefined);

    const unresolved = raw.paths.filter((path) => resolvePath(path, available) === undefined);
    if (unresolved.length > 0) {
      warnings.push(`Subtask "${raw.id}" named files not in the selected context: ${unresolved.join(', ')}. Dropped.`);
    }

    return {
      id: raw.id,
      goal: raw.goal,
      kind: raw.kind,
      difficulty: raw.difficulty,
      context,
      dependsOn: raw.dependsOn.filter((dep) => ids.has(dep) && dep !== raw.id),
    };
  });

  const cycles = findCycle(drafts);
  if (cycles) {
    warnings.push(`Dependency cycle (${cycles.join(' → ')}); dependencies dropped so the plan can run.`);
    for (const draft of drafts) {
      draft.dependsOn = [];
    }
  }

  return { drafts, warnings };
}

interface RawSubtask {
  id: string;
  goal: string;
  kind: SubtaskKind;
  difficulty: Difficulty;
  paths: string[];
  dependsOn: string[];
}

/**
 * Resolves a path the planner named against the actually-available context.
 *
 * Tolerates the common mismatch where the model returns an absolute path but
 * the context is keyed by the workspace-relative one (or vice versa), matching
 * on a path suffix and finally on basename.
 */
export function resolvePath(named: string, available: Map<string, ContextRef>): ContextRef | undefined {
  const norm = named.replace(/\\/g, '/');
  const direct = available.get(norm);
  if (direct) {
    return direct;
  }
  const base = norm.split('/').pop() ?? norm;
  let basenameHit: ContextRef | undefined;
  for (const [key, ref] of available) {
    if (norm.endsWith(key) || key.endsWith(norm)) {
      return ref; // suffix match is strong — prefer it
    }
    if ((key.split('/').pop() ?? key) === base) {
      basenameHit = ref;
    }
  }
  return basenameHit;
}

/**
 * Depth-first cycle detection. A model-authored DAG is not guaranteed to be
 * acyclic, and a cycle would deadlock the runner rather than fail loudly.
 */
export function findCycle(drafts: { id: string; dependsOn: string[] }[]): string[] | undefined {
  const graph = new Map(drafts.map((d) => [d.id, d.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') {
      return undefined;
    }
    if (state.get(id) === 'visiting') {
      return [...stack.slice(stack.indexOf(id)), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const draft of drafts) {
    const cycle = visit(draft.id);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

/** Execution waves: each wave may run in parallel once the prior one is done. */
export function topologicalWaves(drafts: { id: string; dependsOn: string[] }[]): string[][] {
  const remaining = new Map(drafts.map((d) => [d.id, new Set(d.dependsOn)]));
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id);

    if (ready.length === 0) {
      // Cycle detection above should prevent this; emit the rest as one wave
      // rather than looping forever.
      waves.push([...remaining.keys()]);
      break;
    }

    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
    for (const deps of remaining.values()) {
      for (const id of ready) {
        deps.delete(id);
      }
    }
  }

  return waves;
}
