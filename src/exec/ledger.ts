import type { ArtifactKind, Ledger, LedgerEntry, Subtask } from '../types/ir.ts';
import { estimateTokens } from '../optimize/tokens.ts';
import { extractEdits } from '../optimize/outputPolicy.ts';
import type { RunResult } from './adapters/types.ts';

/**
 * How subtasks hand off to each other.
 *
 * The naive approach — append each subtask's full output to the next one's
 * prompt — makes context grow quadratically. Six subtasks in a chain and the
 * last one pays for all five predecessors in full, on a frontier model.
 *
 * Instead each subtask contributes a *summary plus references*. Downstream
 * subtasks get the summaries by default and the full body only when they
 * explicitly declare a dependency on that entry. Context stays linear and
 * small, which is the difference between a plan that saves money and one that
 * merely rearranges where it is spent.
 */

export class RunLedger {
  private entries: LedgerEntry[] = [];

  /** Extracts artifacts from a completed subtask. */
  record(subtask: Subtask, result: RunResult): LedgerEntry[] {
    const produced: LedgerEntry[] = [];

    if (!result.ok) {
      produced.push(
        this.push({
          id: `${subtask.id}.error`,
          producedBy: subtask.id,
          kind: 'note',
          summary: `Failed: ${result.error ?? 'unknown error'}`,
          refs: [],
          tokens: 0,
        }),
      );
      return produced;
    }

    const edits = extractEdits(result.structured);
    if (edits.length > 0) {
      for (const [index, edit] of edits.entries()) {
        produced.push(
          this.push({
            id: `${subtask.id}.edit.${index}`,
            producedBy: subtask.id,
            kind: 'diff',
            summary: `Edit ${edit.path}: ${firstLine(edit.replace) || 'replacement'}`,
            body: JSON.stringify(edit),
            refs: [edit.path],
            tokens: estimateTokens(edit.search + edit.replace, 'code'),
          }),
        );
      }
      return produced;
    }

    const findings = extractFindings(result.structured);
    if (findings.length > 0) {
      for (const [index, finding] of findings.entries()) {
        produced.push(
          this.push({
            id: `${subtask.id}.finding.${index}`,
            producedBy: subtask.id,
            kind: 'finding',
            summary: finding.summary,
            refs: finding.refs,
            tokens: estimateTokens(finding.summary),
          }),
        );
      }
      return produced;
    }

    // Unstructured reply: keep the body, but downstream still sees only the
    // first line unless it declares a dependency.
    produced.push(
      this.push({
        id: `${subtask.id}.output`,
        producedBy: subtask.id,
        kind: 'note',
        summary: firstLine(result.text) || 'completed',
        body: result.text,
        refs: [],
        tokens: estimateTokens(result.text),
      }),
    );
    return produced;
  }

  private push(entry: LedgerEntry): LedgerEntry {
    this.entries.push(entry);
    return entry;
  }

  snapshot(): Ledger {
    return { entries: [...this.entries] };
  }

  byProducer(subtaskId: string): LedgerEntry[] {
    return this.entries.filter((entry) => entry.producedBy === subtaskId);
  }

  /**
   * Builds the handoff block for a subtask about to run.
   *
   * Entries produced by declared dependencies get their full body. Everything
   * else contributes one summary line, which is enough for the model to know
   * the work happened without paying to re-read it.
   */
  renderFor(subtask: Subtask, budgetTokens = 4_000): { text: string; tokens: number } {
    if (this.entries.length === 0) {
      return { text: '', tokens: 0 };
    }

    const consumed = new Set(subtask.consumes);
    const lines: string[] = ['PRIOR WORK IN THIS PLAN:'];
    let tokens = 0;

    for (const entry of this.entries) {
      const wantsBody = consumed.has(entry.producedBy) && entry.body;
      const refs = entry.refs.length > 0 ? ` [${entry.refs.join(', ')}]` : '';
      const line = wantsBody
        ? `- ${entry.producedBy}: ${entry.summary}${refs}\n${indent(entry.body ?? '')}`
        : `- ${entry.producedBy}: ${entry.summary}${refs}`;

      const cost = estimateTokens(line);
      if (tokens + cost > budgetTokens) {
        lines.push(`- … ${this.entries.length - lines.length + 1} earlier entries omitted (budget)`);
        break;
      }
      lines.push(line);
      tokens += cost;
    }

    return { text: lines.join('\n'), tokens };
  }

  /** Every edit produced by the run, for the diff review step. */
  allEdits(): { subtaskId: string; path: string; search: string; replace: string }[] {
    const edits: { subtaskId: string; path: string; search: string; replace: string }[] = [];
    for (const entry of this.entries) {
      if (entry.kind !== 'diff' || !entry.body) {
        continue;
      }
      try {
        const edit = JSON.parse(entry.body) as { path: string; search: string; replace: string };
        edits.push({ subtaskId: entry.producedBy, ...edit });
      } catch {
        // A malformed body is a bug upstream; skip rather than fail the run.
      }
    }
    return edits;
  }
}

interface Finding {
  summary: string;
  refs: string[];
}

function extractFindings(structured: unknown): Finding[] {
  if (typeof structured !== 'object' || structured === null) {
    return [];
  }
  const findings = (structured as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    return [];
  }
  return findings
    .filter((f): f is { summary: string; refs?: unknown } =>
      typeof f === 'object' && f !== null && typeof (f as { summary?: unknown }).summary === 'string',
    )
    .map((f) => ({
      summary: f.summary,
      refs: Array.isArray(f.refs) ? f.refs.filter((r): r is string => typeof r === 'string') : [],
    }));
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim().slice(0, 160);
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export type { ArtifactKind };
