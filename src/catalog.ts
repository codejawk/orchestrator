import type { Adapter, Difficulty, Effort, Kind } from './types.ts';

/**
 * The verified model catalog — only entries confirmed selectable on this
 * machine's Claude and Codex logins.
 *
 * Claude: `--model <id>` + `--effort {low,medium,high,xhigh,max}`.
 * Codex:  `--model <slug>` + `-c model_reasoning_effort={low,medium,high,xhigh,max,ultra}`.
 *         (The ChatGPT-subscription account accepts the CURRENT slugs below; it
 *          rejects the deprecated `gpt-5`/`gpt-5-mini` names.)
 *
 * `weight` orders the models cheap→capable, so the guardrail can snap an invalid
 * pick to something sane and the UI can sort. Keep this list conservative — an
 * entry here is a promise the CLI will accept it.
 */

export interface ModelEntry {
  adapter: Adapter;
  /** The exact string passed to `--model`. */
  id: string;
  label: string;
  /** Efforts this model accepts. */
  efforts: Effort[];
  /** Rough capability rank, 1 (cheapest) … 10 (most capable). */
  weight: number;
  /** One line shown to the main model so it can choose well. */
  use: string;
}

export const CATALOG: ModelEntry[] = [
  // Claude
  { adapter: 'claude', id: 'haiku', label: 'Claude Haiku 4.5', efforts: ['low', 'medium'], weight: 2, use: 'trivial code, quick edits, simple prose' },
  { adapter: 'claude', id: 'sonnet', label: 'Claude Sonnet 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], weight: 6, use: 'ordinary implementation needing care' },
  { adapter: 'claude', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], weight: 5, use: 'ordinary implementation (prior sonnet)' },
  { adapter: 'claude', id: 'opus', label: 'Claude Opus 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], weight: 10, use: 'hardest work: concurrency, algorithms, security, design' },
  { adapter: 'claude', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], weight: 9, use: 'hard work (prior opus)' },

  // Codex (current slugs; selectable on the subscription)
  { adapter: 'codex', id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', efforts: ['low', 'medium', 'high', 'xhigh'], weight: 3, use: 'cheap, fast, boilerplate and docs' },
  { adapter: 'codex', id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], weight: 7, use: 'balanced agentic coding for everyday work' },
  { adapter: 'codex', id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], weight: 7, use: 'strong general coding, alternative to Terra' },
  { adapter: 'codex', id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], weight: 6, use: 'general coding' },
];

export function findModel(adapter: Adapter, id: string): ModelEntry | undefined {
  return CATALOG.find((m) => m.adapter === adapter && m.id === id);
}

/**
 * The deterministic guardrail: a safe (model, effort) for a difficulty+kind,
 * used when the main model's pick is missing or not in the catalog. This is the
 * "algorithm" half of routing — it also spreads work across both providers so a
 * plan is not accidentally all-Claude.
 */
export function defaultRoute(kind: Kind, difficulty: Difficulty): { entry: ModelEntry; effort: Effort } {
  const pick = (adapter: Adapter, id: string, effort: Effort) => {
    const entry = findModel(adapter, id) ?? CATALOG[0]!;
    return { entry, effort: clampEffort(entry, effort) };
  };
  if (kind === 'review') {
    return pick('claude', 'opus', 'max');
  }
  if (difficulty === 'hard') {
    return pick('claude', 'opus', 'high');
  }
  if (difficulty === 'standard') {
    // Everyday coding to Codex Terra; keeps Claude budget for the hard parts.
    return pick('codex', 'gpt-5.6-terra', 'medium');
  }
  // mechanical
  return kind === 'docs' ? pick('codex', 'gpt-5.4-mini', 'low') : pick('claude', 'haiku', 'low');
}

/**
 * The closest model on `adapter` to a target capability weight — used to
 * reroute a subtask when its chosen provider is out of quota.
 */
export function nearestOn(adapter: Adapter, targetWeight: number): ModelEntry {
  const onAdapter = CATALOG.filter((m) => m.adapter === adapter);
  return (
    onAdapter.slice().sort((a, b) => Math.abs(a.weight - targetWeight) - Math.abs(b.weight - targetWeight))[0] ??
    CATALOG[0]!
  );
}

/** Clamp an effort to what a model supports (nearest lower, else its lowest). */
export function clampEffort(entry: ModelEntry, effort: Effort): Effort {
  if (entry.efforts.includes(effort)) {
    return effort;
  }
  const order: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const want = order.indexOf(effort);
  for (let i = want; i >= 0; i--) {
    if (entry.efforts.includes(order[i]!)) {
      return order[i]!;
    }
  }
  return entry.efforts[0] ?? 'medium';
}

/** A compact menu of the catalog for the main model's decomposition prompt. */
export function catalogForPrompt(): string {
  return CATALOG.map(
    (m) => `- ${m.adapter}/${m.id} (${m.label}) — ${m.use}. efforts: ${m.efforts.join('/')}`,
  ).join('\n');
}
