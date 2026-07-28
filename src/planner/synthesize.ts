import type { CostRecord, Ledger, PromptIR } from '../types/ir.ts';
import type { Planner } from './gauss.ts';

/**
 * The combine step — your step 6, "the orchestrator combines and gives the
 * result."
 *
 * Subtasks ran on different models and each produced a fragment: a finding, a
 * diff, a note. On their own they read as a scattered list. Synthesis stitches
 * them into one coherent answer to the original goal — what the cause is, what
 * the fix is, what to check.
 *
 * It runs on the planner (Gauss, or the stand-in), for two reasons. It is the
 * orchestrator's own voice, not any one specialist's. And it works from the
 * ledger's summaries — which never left as raw transcripts — so it stays cheap
 * and adds no new external exposure.
 */

const SYNTHESIS_SYSTEM = `You are the orchestrator. Several models each did one subtask of a larger job; you have their results as short entries. Combine them into one clear answer to the original goal.

- Lead with the answer, not a recap of the process.
- Merge overlapping findings; drop noise.
- Keep code references as path:line — do not paste code back.
- If the subtasks disagree or left a gap, say so plainly.
- Be concise. This is a summary, not a transcript.`;

export interface SynthesisResult {
  text: string;
  /** Cost of the combine call, so the run accounting can include it. */
  cost: CostRecord;
  warnings: string[];
}

export async function synthesize(
  ir: PromptIR,
  ledger: Ledger,
  gauss: Planner,
  signal?: AbortSignal,
): Promise<SynthesisResult | undefined> {
  const entries = ledger.entries.filter((entry) => entry.summary.trim().length > 0);

  // Nothing to combine, or only one fragment — synthesis would just echo it and
  // cost a call for no gain.
  if (entries.length <= 1) {
    return undefined;
  }

  const body = entries
    .map((entry) => {
      const refs = entry.refs.length > 0 ? ` [${entry.refs.join(', ')}]` : '';
      const detail = entry.body ? `\n${entry.body.slice(0, 800)}` : '';
      return `- (${entry.kind} from ${entry.producedBy}) ${entry.summary}${refs}${detail}`;
    })
    .join('\n');

  const result = await gauss.complete({
    purpose: 'synthesize',
    system: SYNTHESIS_SYSTEM,
    user: [
      `ORIGINAL GOAL: ${ir.goal}`,
      ir.acceptance.length ? `DONE WHEN:\n${ir.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
      '',
      'SUBTASK RESULTS:',
      body,
      '',
      'Write the combined answer.',
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 1_200,
    ...(signal ? { signal } : {}),
  });

  return {
    text: result.text.trim(),
    cost: result.cost,
    warnings: result.warnings,
  };
}
