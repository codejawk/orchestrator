import type { OutputPolicy, SubtaskKind } from '../types/ir.ts';

/**
 * Output-token control.
 *
 * Output costs roughly five times input, so this is where the "smarter agent"
 * work actually pays. Three levers, in order of effect:
 *
 *   1. A schema. A model given `--json-schema` cannot emit "Certainly! Here's
 *      what I found:" followed by a recap of the question. That padding is
 *      routinely a third of a response.
 *   2. A hard cap sized to the job. A rename does not get a 16k budget.
 *   3. Reasoning budget by kind. Extended thinking on a mechanical edit is
 *      money spent deliberating about nothing.
 */

/**
 * Prepended to every subtask. Terse on purpose — this text is charged as input
 * on every call, so it earns its length or it goes.
 */
export const TERSE_PREAMBLE = [
  'Output only what was asked for.',
  'No preamble, no restatement of the request, no summary of what you did, no offers of further help.',
  'Cite code as path:line rather than quoting it back — the reader has the file open.',
].join(' ');

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          refs: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
        },
        required: ['summary', 'refs', 'severity'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          // Search/replace rather than whole-file rewrites: a full rewrite of a
          // 600-line file costs thousands of output tokens to change four.
          search: { type: 'string' },
          replace: { type: 'string' },
        },
        required: ['path', 'search', 'replace'],
        additionalProperties: false,
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['edits', 'notes'],
  additionalProperties: false,
} as const;

const DEFAULTS: Record<SubtaskKind, OutputPolicy> = {
  analyze: { format: 'json', maxTokens: 1_200, schema: FINDINGS_SCHEMA, reasoning: 'medium' },
  review: { format: 'json', maxTokens: 1_500, schema: FINDINGS_SCHEMA, reasoning: 'medium' },
  edit: { format: 'json', maxTokens: 3_000, schema: EDIT_SCHEMA, reasoning: 'low' },
  refactor: { format: 'json', maxTokens: 4_000, schema: EDIT_SCHEMA, reasoning: 'medium' },
  test: { format: 'json', maxTokens: 2_500, schema: EDIT_SCHEMA, reasoning: 'low' },
  doc: { format: 'prose', maxTokens: 1_000, reasoning: 'off' },
};

export function policyFor(kind: SubtaskKind, overrides: Partial<OutputPolicy> = {}): OutputPolicy {
  return { ...DEFAULTS[kind], ...overrides };
}

/**
 * Scales the cap by how much context the subtask carries.
 *
 * A subtask reasoning over 40k tokens of context legitimately needs more room
 * than one looking at a single function, but the growth is deliberately
 * sub-linear — output length should track the size of the *answer*, not the
 * size of the question.
 */
export function scaleCap(base: number, contextTokens: number): number {
  const factor = 1 + Math.min(1, contextTokens / 40_000);
  return Math.round(base * factor);
}

/** Reasoning maps onto each CLI's own flag vocabulary in the adapters. */
export function reasoningEffort(policy: OutputPolicy): 'none' | 'low' | 'medium' | 'high' {
  return policy.reasoning === 'off' ? 'none' : policy.reasoning;
}

export interface ParsedEdit {
  path: string;
  search: string;
  replace: string;
}

/** Narrows a structured reply to edits, tolerating a model that wrapped them. */
export function extractEdits(structured: unknown): ParsedEdit[] {
  if (typeof structured !== 'object' || structured === null) {
    return [];
  }
  const edits = (structured as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) {
    return [];
  }
  return edits.filter(
    (edit): edit is ParsedEdit =>
      typeof edit === 'object' &&
      edit !== null &&
      typeof (edit as ParsedEdit).path === 'string' &&
      typeof (edit as ParsedEdit).search === 'string' &&
      typeof (edit as ParsedEdit).replace === 'string',
  );
}
