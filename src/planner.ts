import { runClaude, type CliEvent } from './cli.ts';
import { CATALOG, catalogForPrompt } from './catalog.ts';
import { routeFor, type UsageHeadroom } from './router.ts';
import type { Difficulty, Effort, Kind, ModelChoice, Plan, Subtask, SubtaskResult } from './types.ts';

/**
 * The main model. It analyses the prompt into subtasks (step 2) and, at the
 * end, combines the finished pieces into one deliverable (step 7). Both run on
 * the same strong model (Opus by default), because both are judgement, not
 * mechanical work.
 */

export interface MainModel {
  bin: string;
  model: string;
  effort: Effort;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
}

const DECOMPOSE_SYSTEM = `You are the orchestrator. You split a software request into the concrete deliverables it asks for, so each can be handed to a different model.

Rules:
- Produce between 1 and 6 subtasks. Each subtask is a REAL DELIVERABLE the request asks for (a module, a class, a test file, a docs section) — never a process step.
- NEVER create meta subtasks such as "inspect the workspace", "check permissions", "set up the project", "prepare a patch", or "read existing files". You are generating new content from the request; there is nothing to inspect.
- Split by deliverable. If the request lists parts (1)(2)(3), those are your subtasks.
- Set dependsOn only for genuine ordering (tests depend on the code they test; a README depends on the thing it documents). Independent parts must have no dependency so they run in parallel.
- Mark difficulty honestly — it decides which model runs it:
  - "hard": concurrency, thread-safety, locking, algorithms, security, performance, or a real design decision. THREAD-SAFE / CONCURRENT / RACE-FREE work is always "hard".
  - "standard": ordinary implementation requiring care but no deep reasoning.
  - "mechanical": boilerplate, simple glue, docstrings, a README, trivial tests.
- kind is one of: code, test, docs, analysis, review.
- Choose adapter/model/effort for each subtask from this verified catalog only:
${catalogForPrompt()}
- Use Opus/high-or-above or Codex Terra/Luna high-or-above for hard work. Use cheaper models for mechanical work.
- The app will validate your choices and replace invalid/underpowered picks.

Return only the JSON the schema asks for.`;

const modelIds = CATALOG.map((m) => m.id);

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
            title: { type: 'string' },
            goal: { type: 'string' },
            kind: { type: 'string', enum: ['code', 'test', 'docs', 'analysis', 'review'] },
            difficulty: { type: 'string', enum: ['mechanical', 'standard', 'hard'] },
            dependsOn: { type: 'array', items: { type: 'string' } },
            route: {
              type: 'object',
              properties: {
                adapter: { type: 'string', enum: ['claude', 'codex'] },
                model: { type: 'string', enum: modelIds },
                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
                reason: { type: 'string' },
              },
              required: ['adapter', 'model', 'effort', 'reason'],
              additionalProperties: false,
            },
          },
          required: ['id', 'title', 'goal', 'kind', 'difficulty', 'dependsOn', 'route'],
          additionalProperties: false,
        },
      },
    },
    required: ['subtasks'],
    additionalProperties: false,
  },
} as const;

interface RawSubtask {
  id: string;
  title: string;
  goal: string;
  kind: Kind;
  difficulty: Difficulty;
  dependsOn: string[];
  route?: ModelChoice;
}

export async function decompose(
  prompt: string,
  main: MainModel,
  usage?: UsageHeadroom,
  signal?: AbortSignal,
  onEvent?: (event: CliEvent) => void,
): Promise<Plan> {
  const run = await runClaude({
    bin: main.bin,
    model: main.model,
    effort: main.effort,
    system: DECOMPOSE_SYSTEM,
    prompt: `REQUEST:\n${prompt}`,
    schema: DECOMPOSE_SCHEMA.schema,
    cwd: main.cwd,
    env: main.env,
    timeoutMs: main.timeoutMs,
    ...(onEvent ? { onEvent } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!run.ok) {
    throw new Error(`Analysis failed on ${main.model}: ${run.error ?? 'no output'}`);
  }

  const parsed = safeParse<{ subtasks: RawSubtask[] }>(run.text);
  const raws = parsed?.subtasks ?? [];
  if (raws.length === 0) {
    // Degrade to a single subtask over the whole request rather than fail.
    raws.push({
      id: 'task',
      title: 'Complete the request',
      goal: prompt,
      kind: 'code',
      difficulty: 'standard',
      dependsOn: [],
      route: { adapter: 'codex', model: 'gpt-5.6-terra', effort: 'medium', reason: 'fallback route for the whole request' },
    });
  }

  const ids = new Set(raws.map((r) => r.id));
  const subtasks: Subtask[] = raws.map((r) => {
    const route = routeFor(r.kind, r.difficulty, normalizeChoice(r.route), usage);
    return {
      id: r.id,
      title: r.title,
      goal: r.goal,
      kind: r.kind,
      difficulty: r.difficulty,
      dependsOn: r.dependsOn.filter((d) => ids.has(d) && d !== r.id),
      adapter: route.adapter,
      model: route.model,
      effort: route.effort,
      routingNote: route.note,
    };
  });

  return { prompt, subtasks };
}

const SYNTH_SYSTEM = `You are the orchestrator reviewing files that worker models have ALREADY written to disk. Your job is a quick integration review — NOT to re-write or re-print the files.

- Check the files fit together: imports resolve, names/signatures match across files, the docs match the code.
- Write a SHORT report (a few bullet points): what was built, and whether it is consistent.
- ONLY if a file genuinely needs a fix for consistency, output the corrected file — and only that file — wrapped exactly as:
  ===FILE: <path>===
  <corrected full contents>
  ===END FILE===
- Do NOT re-emit files that are already correct. Most reviews need no file blocks at all. Be concise — this step must stay cheap.`;

export async function synthesize(
  plan: Plan,
  results: SubtaskResult[],
  main: MainModel,
  signal?: AbortSignal,
  onEvent?: (event: CliEvent) => void,
): Promise<string> {
  const ok = results.filter((r) => r.ok && r.text.trim());
  if (ok.length === 0) {
    return '_No subtask produced output._';
  }
  if (ok.length === 1) {
    return `Single deliverable produced by ${ok[0]!.adapter}/${ok[0]!.model}. No cross-file integration needed.`;
  }

  // Send a compact manifest (file names per subtask) plus the raw outputs so the
  // reviewer can spot mismatches, without asking it to reproduce anything.
  const body = ok
    .map((r) => {
      const sub = plan.subtasks.find((s) => s.id === r.id);
      return `### ${sub?.title ?? r.id}  (${r.adapter}/${r.model})\n${r.text}`;
    })
    .join('\n\n---\n\n');

  const run = await runClaude({
    bin: main.bin,
    model: main.model,
    effort: main.effort,
    system: SYNTH_SYSTEM,
    prompt: `ORIGINAL REQUEST:\n${plan.prompt}\n\nFILES THE WORKERS WROTE (for your review — do not reprint them):\n\n${body}`,
    cwd: main.cwd,
    env: main.env,
    timeoutMs: main.timeoutMs,
    ...(onEvent ? { onEvent } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!run.ok) {
    return `_Integration review unavailable (${run.error ?? 'failed'}). Files were still written by the workers._`;
  }
  return run.text;
}

function normalizeChoice(choice: unknown): Partial<ModelChoice> | undefined {
  if (!choice || typeof choice !== 'object') {
    return undefined;
  }
  const raw = choice as Record<string, unknown>;
  return {
    ...(raw.adapter === 'claude' || raw.adapter === 'codex' ? { adapter: raw.adapter } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(isEffort(raw.effort) ? { effort: raw.effort } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isEffort(value: unknown): value is Effort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra';
}

function safeParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }
}
