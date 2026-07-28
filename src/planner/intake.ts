import type { IntakeResult } from '../types/ir.ts';
import { estimateTokens } from '../optimize/tokens.ts';
import type { Planner } from './gauss.ts';

/**
 * The clarify gate.
 *
 * This is the single largest saving in the system and the least sophisticated.
 * A vague prompt that sends a frontier model exploring for 40k tokens and
 * returns the wrong thing is 100% waste — not 30% overhead, total loss. Three
 * questions answered up front prevent it.
 *
 * The gate is mandatory rather than a mode the developer can skip, because the
 * developer in a hurry is exactly the one who needs it.
 */

const INTAKE_SYSTEM = `You triage coding requests before an expensive model runs.

Your default is to ASK NOTHING. Most requests are actionable as written. Only ask a question when, without the answer, you would write materially different code — and the answer is something you genuinely cannot get by reading the files yourself.

NEVER ask a question whose answer you could find by opening the file. In particular do NOT ask:
- whether a file is new or existing (you can see it in the workspace)
- what language or format a file is (you can see its contents)
- whether a file "contains code" (you can read it)
- to confirm something the request already states

Read-only requests are almost always actionable with ZERO questions. Treat these as clear and ask nothing:
- "what does X do", "explain X", "summarize X", "how does X work"
- "find bugs in X", "review X", "is there anything wrong with X"
- "list the files", "document X"

Only these make a request unclear, and only when they change what code gets written:
- the target is unnamed AND cannot be inferred from the open file or the workspace
- behaviour is given only as a vague adjective ("better", "faster", "cleaner") with no measurable target
- two or more materially different implementations exist and nothing chooses between them

Ask at most 3 questions, and prefer 0. A wrong-but-reasonable assumption is better than a question the developer finds obvious. For every question you do ask, state what you would assume if it is skipped.

Set fastPath when the task is single-file, single-concern, and under roughly twenty lines of change.`;

const INTAKE_SCHEMA = {
  name: 'intake',
  schema: {
    type: 'object',
    properties: {
      ambiguityScore: { type: 'number', minimum: 0, maximum: 1 },
      fastPath: { type: 'boolean' },
      restatedGoal: { type: 'string' },
      questions: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            assumptionIfSkipped: { type: 'string' },
          },
          required: ['id', 'question', 'options', 'assumptionIfSkipped'],
          additionalProperties: false,
        },
      },
    },
    required: ['ambiguityScore', 'fastPath', 'restatedGoal', 'questions'],
    additionalProperties: false,
  },
} as const;

interface RawIntake {
  ambiguityScore: number;
  fastPath: boolean;
  restatedGoal: string;
  questions: {
    id: string;
    question: string;
    options: string[];
    assumptionIfSkipped: string;
  }[];
}

export interface IntakeContext {
  /** Paths visible in the workspace, for grounding. Contents are not sent. */
  paths: string[];
  /** Open editor path, which is usually what the developer means by "this". */
  activePath?: string;
}

export interface IntakeOutcome extends IntakeResult {
  /** Gauss's one-line restatement, shown back so misreadings surface early. */
  restatedGoal: string;
  warnings: string[];
}

/** Above this, we ask even if the model wanted to proceed. */
const FORCE_QUESTIONS_ABOVE = 0.75;

export async function analyzeIntake(
  prompt: string,
  gauss: Planner,
  context: IntakeContext,
  signal?: AbortSignal,
): Promise<IntakeOutcome> {
  // Only paths go to Gauss here, never file contents: at intake we have not
  // scanned anything yet, so nothing has been cleared for inclusion.
  const inventory = context.paths.slice(0, 400).join('\n');

  const result = await gauss.complete<RawIntake>({
    purpose: 'intake',
    system: INTAKE_SYSTEM,
    user: [
      `Request:\n${prompt}`,
      context.activePath ? `\nCurrently open file: ${context.activePath}` : '',
      `\nWorkspace paths (${context.paths.length} total, truncated):\n${inventory}`,
    ].join('\n'),
    schema: INTAKE_SCHEMA,
    maxTokens: 600,
    ...(signal ? { signal } : {}),
  });

  const warnings = [...result.warnings];
  const data = result.data;

  if (!data) {
    // Fail toward asking. Guessing at a request we could not parse is the
    // expensive failure; one extra question is the cheap one.
    warnings.push('Intake analysis failed to parse; asking for clarification rather than guessing.');
    return {
      ambiguityScore: 1,
      fastPath: false,
      restatedGoal: prompt.trim(),
      questions: [
        {
          id: 'fallback',
          question: 'Which files or modules should this change touch, and what should be true when it is done?',
          assumptionIfSkipped: 'I will infer the scope from the open editor and the prompt alone.',
        },
      ],
      warnings,
    };
  }

  const score = clamp01(data.ambiguityScore);
  let questions = data.questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options?.length ? q.options : undefined,
    assumptionIfSkipped: q.assumptionIfSkipped,
  }));

  if (score >= FORCE_QUESTIONS_ABOVE && questions.length === 0) {
    warnings.push(
      `Model scored the request ${score.toFixed(2)} for ambiguity but asked nothing; adding a scope question.`,
    );
    questions = [
      {
        id: 'forced-scope',
        question: 'What exactly should change, and how will you know it worked?',
        options: undefined,
        assumptionIfSkipped: 'I will proceed on my best reading of the prompt.',
      },
    ];
  }

  return {
    ambiguityScore: score,
    // A request nobody can pin down is not a fast path, whatever its size.
    fastPath: data.fastPath && questions.length === 0,
    questions,
    restatedGoal: data.restatedGoal || prompt.trim(),
    warnings,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

export interface ClarificationAnswer {
  id: string;
  question: string;
  answer: string;
}

/**
 * Folds answers back into a single statement of intent.
 *
 * Done locally rather than with another Gauss call: string assembly does not
 * need a model, and every call we avoid is planning overhead that does not eat
 * into the reported saving.
 */
export function mergeAnswers(
  originalPrompt: string,
  restatedGoal: string,
  answered: ClarificationAnswer[],
  skipped: { question: string; assumptionIfSkipped: string }[],
): string {
  const parts = [`Request: ${originalPrompt.trim()}`];

  if (restatedGoal && restatedGoal !== originalPrompt.trim()) {
    parts.push(`Understood as: ${restatedGoal}`);
  }
  for (const { question, answer } of answered) {
    parts.push(`${question}\n  → ${answer}`);
  }
  for (const { question, assumptionIfSkipped } of skipped) {
    parts.push(`${question}\n  → not answered; assuming: ${assumptionIfSkipped}`);
  }
  return parts.join('\n\n');
}

/**
 * What a wasted run would have cost, for the "runs avoided" line in the report.
 *
 * Reported separately from the token arithmetic because it is a different kind
 * of claim — it counts runs that never happened — and blending the two would
 * produce a headline nobody could audit.
 */
export function clarificationChangedScope(
  before: string,
  after: string,
  threshold = 0.25,
): boolean {
  const beforeTokens = estimateTokens(before);
  const afterTokens = estimateTokens(after);
  if (beforeTokens === 0) {
    return afterTokens > 0;
  }
  return Math.abs(afterTokens - beforeTokens) / beforeTokens >= threshold;
}
