import { runClaude, type CliEvent } from './cli.ts';
import { CATALOG, catalogForPrompt } from './catalog.ts';
import { routeFor, type UsageHeadroom } from './router.ts';
import type { Difficulty, Effort, Kind, ModelChoice, OutputKind, Plan, Subtask, SubtaskResult } from './types.ts';

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

const DECOMPOSE_SYSTEM = `You are the orchestrator. You split a software request into subtasks that can each be handed to a different model.

The request may be one of two kinds — decide which from the request and the workspace file list:
  • BUILD new code from a description (there may be no relevant existing files).
  • WORK WITH the existing code already in the workspace: understand/explain it, review it, debug it, or modify it. When the request says things like "read", "understand", "explain", "review", "fix", "refactor", "the code in this folder", it is THIS kind — the files listed in the workspace are what it refers to.

For each subtask set:
- kind: one of code, test, docs, analysis, review.
- output: "files" if the subtask should WRITE code/docs files, or "prose" if it should return an explanation/answer/review as text. Understanding/explaining/reviewing existing code is ALWAYS output "prose". Building or editing code is output "files".
- reads: true if the subtask must READ the existing workspace files to do its job (understanding, reviewing, modifying existing code all read). false for pure from-scratch generation.

Rules:
- Produce between 1 and 6 subtasks. Each is a real deliverable (an explanation of a component, a written module, a review) — never a process step like "set up the project".
- PREFER FEWER SUBTASKS. Every subtask is a separate model call that re-reads its files from scratch, so splitting has a real token cost. Only split when the parts are genuinely independent or need different models. A small codebase or a focused question should be ONE subtask.
- When you DO split a read/understand task, assign each file (or directory) to AT MOST ONE subtask — never let two subtasks read the same file, or you pay to read it twice. Name the specific files each subtask should read in its goal.
- For an "understand this codebase" request, split by NON-OVERLAPPING area/component only if the codebase is large; otherwise use one subtask. Set output=prose, reads=true. Do NOT invent files to write.
- Split code work by deliverable. If the request lists parts (1)(2)(3), those are your subtasks.
- MODIFYING existing code (fix/refactor/extend a file that already exists) is output=files, reads=true — the worker will read the file and emit a minimal diff, not rewrite it.
- dependsOn: only for genuine ordering. Independent parts must have no dependency so they run in parallel.
- difficulty (drives model choice):
  - "hard": genuinely hard GENERATION or DEBUGGING — concurrency, thread-safety, locking, tricky algorithms, security, performance, or subtle bug-hunting. Use sparingly.
  - "standard": ordinary implementation, and ALL reading/understanding/explaining/reviewing of existing code — even a large codebase. Explaining code is standard, not hard: it must NOT use a frontier (Opus) model. A Sonnet-class model reads and explains excellently at a fraction of the cost.
  - "mechanical": boilerplate, simple glue, a README, trivial tests, a short summary.
- Reading/understanding/explaining is output=prose and difficulty=standard (never hard). Do not mark it hard just because the code is intricate.
- Choose adapter/model/effort per subtask from this verified catalog only:
${catalogForPrompt()}
- Use Opus (or Codex Terra/Luna) at high+ for hard work; cheaper models for mechanical work. The app validates and may replace invalid/underpowered picks.

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
            output: { type: 'string', enum: ['files', 'prose'] },
            reads: { type: 'boolean' },
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
          required: ['id', 'title', 'goal', 'kind', 'difficulty', 'output', 'reads', 'dependsOn', 'route'],
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
  output?: OutputKind;
  reads?: boolean;
  dependsOn: string[];
  route?: ModelChoice;
}

export async function decompose(
  prompt: string,
  main: MainModel,
  fileList: string,
  codeMap: string,
  usage?: UsageHeadroom,
  signal?: AbortSignal,
  onEvent?: (event: CliEvent) => void,
): Promise<Plan> {
  const map = codeMap ? `\n\nCODE MAP (file → its top-level definitions):\n${codeMap}` : '';
  const run = await runClaude({
    bin: main.bin,
    model: main.model,
    effort: main.effort,
    system: DECOMPOSE_SYSTEM,
    prompt: `WORKSPACE FILES:\n${fileList}${map}\n\nREQUEST:\n${prompt}`,
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
      output: 'files',
      reads: false,
      dependsOn: [],
      route: { adapter: 'codex', model: 'gpt-5.6-terra', effort: 'medium', reason: 'fallback route for the whole request' },
    });
  }

  const ids = new Set(raws.map((r) => r.id));
  const subtasks = raws.map((r) => toSubtask(r, ids, usage));
  return { prompt, subtasks };
}

/** Build a routed Subtask from the main model's raw spec. Shared by decompose + triage. */
function toSubtask(r: RawSubtask, ids: Set<string>, usage?: UsageHeadroom): Subtask {
  const route = routeFor(r.kind, r.difficulty, normalizeChoice(r.route), usage);
  // Analysis/review are always prose; if the model didn't say, infer sensibly.
  const output: OutputKind = r.output ?? (r.kind === 'analysis' || r.kind === 'review' ? 'prose' : 'files');
  const reads = r.reads ?? (output === 'prose' || r.kind === 'review');
  return {
    id: r.id,
    title: r.title,
    goal: r.goal,
    kind: r.kind,
    difficulty: r.difficulty,
    output,
    reads,
    dependsOn: r.dependsOn.filter((d) => ids.has(d) && d !== r.id),
    adapter: route.adapter,
    model: route.model,
    effort: route.effort,
    routingNote: route.note,
  };
}

// ---------------------------------------------------------------------------
// Fast path: a cheap triage that avoids orchestration overhead for simple asks
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM = `You are a fast router. Decide whether a coding request needs to be SPLIT across multiple models, or is a single focused task one model can do in one shot.

Set direct=true when the request is ONE deliverable or question: a single function/file, a small edit to one file, or a focused question about the code. Set direct=false when it clearly has multiple distinct deliverables (e.g. "a module AND tests AND a README") or mixes genuinely hard and easy parts worth different models.

If direct=true, also fill the single task: its kind (code|test|docs|analysis|review), difficulty (mechanical|standard|hard), output, reads, and a route.
- output="files" when asked to write/create/implement/add/fix code or docs that should live in a file (this is the usual case for "write a function/script/module"). output="prose" ONLY for a question, explanation, or review that should be answered as text.
- reads=true if it must read existing workspace files.
- Choose the route (adapter/model/effort) from this catalog:
${catalogForPrompt()}
Pick a strong model+effort for hard tasks, a cheap one for trivial tasks. Return only the JSON the schema asks for.`;

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    direct: { type: 'boolean' },
    reason: { type: 'string' },
    title: { type: 'string' },
    goal: { type: 'string' },
    kind: { type: 'string', enum: ['code', 'test', 'docs', 'analysis', 'review'] },
    difficulty: { type: 'string', enum: ['mechanical', 'standard', 'hard'] },
    output: { type: 'string', enum: ['files', 'prose'] },
    reads: { type: 'boolean' },
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
  required: ['direct', 'reason'],
  additionalProperties: false,
} as const;

export interface TriageResult {
  direct: boolean;
  reason: string;
  /** A one-subtask plan to run, when direct. */
  plan?: Plan;
}

/**
 * A cheap (Haiku, low-effort) gate. If the request is a single focused task it
 * returns a one-subtask plan so the caller can skip the expensive decompose and
 * combine steps — the fast path. Anything uncertain falls through to full
 * orchestration.
 */
export async function triage(
  prompt: string,
  main: MainModel,
  fileList: string,
  usage?: UsageHeadroom,
  signal?: AbortSignal,
  onEvent?: (event: CliEvent) => void,
): Promise<TriageResult> {
  const run = await runClaude({
    bin: main.bin,
    model: 'haiku',
    effort: 'low',
    system: TRIAGE_SYSTEM,
    prompt: `WORKSPACE FILES:\n${fileList}\n\nREQUEST:\n${prompt}`,
    schema: TRIAGE_SCHEMA,
    cwd: main.cwd,
    env: main.env,
    timeoutMs: main.timeoutMs,
    ...(onEvent ? { onEvent } : {}),
    ...(signal ? { signal } : {}),
  });

  const t = safeParse<{ direct?: boolean; reason?: string } & Partial<RawSubtask>>(run.text);
  if (!run.ok || !t || t.direct !== true) {
    return { direct: false, reason: t?.reason ?? 'needs orchestration' };
  }
  const raw: RawSubtask = {
    id: 'task',
    title: t.title ?? 'Complete the request',
    goal: t.goal ?? prompt,
    kind: t.kind ?? 'code',
    difficulty: t.difficulty ?? 'standard',
    output: t.output,
    reads: t.reads,
    dependsOn: [],
    ...(t.route ? { route: t.route } : {}),
  };
  const subtask = toSubtask(raw, new Set(['task']), usage);
  return { direct: true, reason: t.reason ?? 'single focused task', plan: { prompt, subtasks: [subtask] } };
}

const REVIEW_SYSTEM = `You are the orchestrator reviewing files that worker models have ALREADY written to disk in the current working directory. Your job is a quick integration review — NOT to re-write or re-print the files.
- Open the files with your read tools ONLY as needed to check they fit together: imports resolve, names/signatures match across files, docs match code. Do not read files that are irrelevant to consistency.
- Write a SHORT report (a few bullet points): what was built, and whether it is consistent.
- ONLY if a file genuinely needs a fix for consistency, output the corrected file — and only that file — wrapped exactly as:
  ===FILE: <path>===
  <corrected full contents>
  ===END FILE===
- Do NOT re-emit files that are already correct. Most reviews need no file blocks at all. Be concise.`;

const EXPLAIN_SYSTEM = `You are the orchestrator writing the FINAL answer for the user by combining what the worker models found. The workers analysed parts of the request; your job is to synthesise one clear, well-structured answer.
- Write for the user directly, in Markdown. Merge the pieces into a coherent explanation — do not just concatenate them, and do not repeat each worker verbatim.
- Keep it focused and useful: structure with short headings/bullets where it helps. Reference real file/symbol names the workers mentioned.
- Do NOT wrap anything in ===FILE:=== markers — this is an answer, not files to write.`;

export async function synthesize(
  plan: Plan,
  results: SubtaskResult[],
  main: MainModel,
  writtenFiles: string[],
  signal?: AbortSignal,
  onEvent?: (event: CliEvent) => void,
): Promise<string> {
  const ok = results.filter((r) => r.ok && r.text.trim());
  if (ok.length === 0) {
    return '_No subtask produced output._';
  }

  // Prose-dominant runs (understand/explain/review) get a combined ANSWER;
  // file-dominant runs get a cheap integration review that reads from disk.
  const proseCount = plan.subtasks.filter((s) => s.output === 'prose').length;
  const mode: 'explain' | 'review' = proseCount > plan.subtasks.length / 2 ? 'explain' : 'review';

  // One successful subtask needs no combine — return it directly and save a
  // whole extra model call (this is the common case for simple requests).
  if (ok.length === 1) {
    return mode === 'explain'
      ? ok[0]!.text
      : `${writtenFiles.length ? `Wrote ${writtenFiles.join(', ')}. ` : ''}Single deliverable — no cross-file integration needed.`;
  }

  if (mode === 'review') {
    if (writtenFiles.length <= 1) {
      return `${writtenFiles.length === 1 ? `Wrote ${writtenFiles[0]}. ` : ''}Single deliverable — no cross-file integration needed.`;
    }
    // Do NOT inline file contents; the reviewer reads them from disk on demand.
    const run = await runClaude({
      bin: main.bin,
      model: main.model,
      effort: main.effort,
      system: REVIEW_SYSTEM,
      prompt: `ORIGINAL REQUEST:\n${clip(plan.prompt, 500)}\n\nThe workers wrote these files to the working directory:\n${writtenFiles.map((f) => `- ${f}`).join('\n')}\n\nReview them for consistency (read only what you need).`,
      allowRead: true,
      cwd: main.cwd,
      env: main.env,
      timeoutMs: main.timeoutMs,
      ...(onEvent ? { onEvent } : {}),
      ...(signal ? { signal } : {}),
    });
    return run.ok ? run.text : `_Review unavailable (${run.error ?? 'failed'}). Files were still written._`;
  }

  // Explain: the worker findings ARE the answer material — pass them, capped.
  const body = ok
    .map((r) => {
      const sub = plan.subtasks.find((s) => s.id === r.id);
      return `### ${sub?.title ?? r.id}  (${r.adapter}/${r.model})\n${clip(r.text, 4000)}`;
    })
    .join('\n\n---\n\n');

  const run = await runClaude({
    bin: main.bin,
    model: main.model,
    effort: main.effort,
    system: EXPLAIN_SYSTEM,
    prompt: `USER'S REQUEST:\n${clip(plan.prompt, 500)}\n\nWHAT THE WORKER MODELS FOUND:\n\n${body}\n\nWrite the final combined answer for the user.`,
    cwd: main.cwd,
    env: main.env,
    timeoutMs: main.timeoutMs,
    ...(onEvent ? { onEvent } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!run.ok) {
    return `_Combine step unavailable (${run.error ?? 'failed'}). The per-subtask results are still shown below._`;
  }
  return run.text;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
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
