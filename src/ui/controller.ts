import * as vscode from 'vscode';
import { policyConfig, securityEnabled } from '../config.ts';
import { OrchestratorSession, Pipeline } from '../pipeline.ts';
import { showReviewPanel } from '../panel/ReviewPanel.ts';
import { showPlanPanel } from '../panel/PlanPanel.ts';
import { formatTokens, formatUsd } from '../optimize/tokens.ts';
import type { RunnerEvent } from '../exec/runner.ts';
import type { FileVerdict } from '../planner/scanner.ts';
import type { IntakeOutcome } from '../planner/intake.ts';
import type { OutputSink } from './sink.ts';

/**
 * The conversation engine, shared by every surface.
 *
 * Holds the one live conversation and the "waiting for clarification answers"
 * state, and runs the full pipeline flow against an `OutputSink`. The native
 * chat participant and the sidebar webview both wrap one of these; the only
 * thing that differs between them is the sink and how a "new conversation" is
 * signalled.
 */
export class ConversationController {
  private readonly pipeline: Pipeline;
  private conversation?: OrchestratorSession;
  private awaiting?: OrchestratorSession;

  constructor(pipeline: Pipeline) {
    this.pipeline = pipeline;
  }

  /** Starts a fresh conversation on the next message. */
  reset(): void {
    this.conversation = undefined;
    this.awaiting = undefined;
  }

  /** The current conversation, for commands like the savings report. */
  current(): OrchestratorSession | undefined {
    return this.conversation;
  }

  /**
   * Handles one user message.
   *
   * `forceNew` starts a fresh conversation (the sidebar's "new chat" button).
   * When omitted, a message continues the existing conversation — reusing the
   * workspace scan and the accumulated taint — unless there is none yet.
   */
  async handle(
    prompt: string,
    attached: string,
    sink: OutputSink,
    token: vscode.CancellationToken,
    forceNew = false,
  ): Promise<void> {
    try {
      // A reply to clarifying questions continues that same turn.
      if (this.awaiting) {
        const session = this.awaiting;
        this.awaiting = undefined;
        absorbAnswers(session, prompt);
        sink.markdown('Thanks — using that.\n\n');
        await this.runTurn(session, sink, token);
        return;
      }

      const isFollowUp = !forceNew && this.conversation !== undefined;
      const session = isFollowUp ? this.conversation! : new OrchestratorSession(`c-${Date.now()}`);
      this.conversation = session;
      session.startTurn();
      this.pipeline.resetGauss();

      if (isFollowUp) {
        sink.markdown(
          `_Follow-up in this conversation — ${session.turns.length} prior turn${session.turns.length === 1 ? '' : 's'}, reusing the workspace scan._\n\n`,
        );
      }

      // Stage 0: guard what the user typed or attached.
      const assessment = this.pipeline.guardPrompt(session, prompt, attached);
      if (assessment.summary) {
        sink.markdown(`> ${assessment.summary}\n\n`);
      }

      // Stage 1: sweep, but only the first time in a conversation.
      if (session.needsSweep) {
        sink.progress('Sweeping the workspace…');
        const sweep = await this.pipeline.sweep(session, undefined, token);
        if (sweep.totalFiles === 0) {
          sink.markdown('No readable source files found in this workspace.');
          return;
        }
        sink.markdown(
          `Swept **${sweep.totalFiles} files** at no cost. ` +
            `${sweep.restricted.length} matched a restricted pattern and are excluded from external use entirely` +
            `${sweep.restricted.length > 0 ? ` (${sweep.restricted.slice(0, 3).map((p) => `\`${p}\``).join(', ')}${sweep.restricted.length > 3 ? ', …' : ''})` : ''}.\n\n`,
        );
      }

      // A file named in the prompt is read even if it exceeds the bulk size
      // limit — an explicit request overrides the sweep's caution.
      const forced = await this.pipeline.includeNamedFiles(session, session.guardedPrompt);
      if (forced.length > 0) {
        sink.markdown(
          `Reading **${forced.length} file${forced.length === 1 ? '' : 's'}** you named directly, past the size limit: ` +
            `${forced.map((p) => `\`${p}\``).join(', ')}. Large files are truncated when sent to a model.\n\n`,
        );
      }

      // Stage 2: clarify.
      sink.progress('Checking the request is clear enough to act on…');
      const intake = await this.pipeline.intake(session, token);

      if (intake.questions.length > 0) {
        renderQuestions(sink, intake);
        this.awaiting = session;
        return;
      }
      if (intake.restatedGoal) {
        sink.markdown(`Understood as: _${session.reveal(intake.restatedGoal)}_\n\n`);
      }

      await this.runTurn(session, sink, token);
    } catch (error) {
      sink.markdown(`\n\n**Stopped.** ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stages 3–9: select, review, plan, approve, execute, report. */
  private async runTurn(
    session: OrchestratorSession,
    sink: OutputSink,
    token: vscode.CancellationToken,
  ): Promise<void> {
    sink.progress('Choosing relevant files…');
    const { report, excludedBySweep } = await this.pipeline.selectAndScan(
      session,
      (message) => sink.progress(message),
      token,
    );

    if (report.files.length === 0) {
      sink.markdown('No files were selected as relevant.\n\n');

      // The most common real cause: the file the user means was skipped for size
      // before the selector ever saw it. Say so, with the fix.
      const bySize = session.sweepSkipped.filter((s) => /over the .* limit/.test(s.reason));
      if (bySize.length > 0) {
        sink.markdown(
          `**${bySize.length} file(s) were skipped for being too large** and never reached the selector:\n\n` +
            bySize.slice(0, 6).map((s) => `- \`${s.path}\` — ${s.reason}`).join('\n') +
            '\n\nRaise `orchestrator.scan.maxFileBytes` in Settings to include them. ' +
            'Note a very large file is a lot of tokens, so it will be skeletonized when sent to a model.\n\n',
        );
      } else {
        sink.markdown('Try naming the specific module or file you mean.\n\n');
      }

      if (excludedBySweep.length > 0) {
        sink.markdown(
          `_${excludedBySweep.length} file(s) were excluded by the restricted-pattern sweep and were never offered to the selector._`,
        );
      }
      return;
    }

    const scanUsd = report.costs.reduce((sum, record) => sum + record.usd, 0);
    sink.markdown(
      `Selected and classified **${report.files.length} file${report.files.length === 1 ? '' : 's'}** ` +
        `out of ${session.files.length} in the workspace — ${formatUsd(scanUsd)}.\n\n`,
    );

    // Stage 5: review.
    if (!securityEnabled()) {
      // Pure-orchestration mode: no classification, no review gate.
      sink.markdown('_Security checks are off — routing directly to the best model per subtask._\n\n');
    } else if (session.taint.isTainted) {
      sink.markdown(
        `> **This run is pinned to Gauss.** ${session.taint.explanation}\n\n` +
          'No file review is needed — nothing is going to an external model either way.\n\n',
      );
    } else {
      const pending = this.pipeline.pendingReview(report);
      if (pending.length === 0) {
        sink.markdown('_All selected files were already reviewed earlier in this conversation._\n\n');
      } else {
        sink.markdown(
          `Opening the review panel for **${pending.length} file${pending.length === 1 ? '' : 's'}** not yet decided. ` +
            '**Nothing leaves the network until you approve it.**\n\n',
        );
        const decision = await showReviewPanel(report, this.pipeline.approvals, policyConfig().allowRestrictedOverride);
        if (!decision) {
          sink.markdown('Review cancelled — nothing was sent anywhere.');
          return;
        }
        const byPath = new Map(report.files.map((file) => [file.path, file]));
        const pick = (paths: string[]): FileVerdict[] =>
          paths.map((path) => byPath.get(path)).filter((file): file is FileVerdict => Boolean(file));

        const allowed = await this.pipeline.recordApprovals(pick(decision.externalAllowed), 'external-allowed');
        await this.pipeline.recordApprovals(pick(decision.gaussOnly), 'gauss-only');
        sink.markdown(
          `**${allowed.applied}** approved for external models, **${decision.gaussOnly.length}** staying on Gauss.\n\n`,
        );
        for (const reason of allowed.rejected.slice(0, 3)) {
          sink.markdown(`> ${reason}\n\n`);
        }
      }
    }

    // Stage 6: plan.
    sink.progress('Planning on Gauss…');
    const { plan, warnings, compression } = await this.pipeline.buildPlan(
      session,
      (message) => sink.progress(message),
      token,
    );
    if (plan.subtasks.length === 0) {
      sink.markdown('Planning produced no subtasks. Try rephrasing the request.');
      return;
    }
    const compressed = Math.round((1 - compression.after / Math.max(1, compression.before)) * 100);
    sink.markdown(
      `Planned **${plan.subtasks.length} subtask${plan.subtasks.length === 1 ? '' : 's'}**, ` +
        `prompt compressed ${compressed}%, forecast ${formatUsd(plan.estimate.usd)}.\n\n`,
    );

    // Stage 7: approve.
    const approval = await showPlanPanel(plan, warnings, compression);
    if (!approval?.approved) {
      sink.markdown('Plan rejected — nothing ran.');
      return;
    }
    if (approval.excluded.length > 0) {
      plan.subtasks = plan.subtasks.filter((subtask) => !approval.excluded.includes(subtask.id));
      session.plan = plan;
    }

    // Stage 8: execute.
    const started = new Set<string>();
    const outcome = await this.pipeline.execute(
      session,
      (event: RunnerEvent) => {
        if (event.type === 'subtask-start' && !started.has(event.subtask.id)) {
          started.add(event.subtask.id);
          sink.progress(`${event.subtask.id} → ${event.subtask.adapter}/${event.subtask.model}`);
        }
      },
      token,
    );

    // Stage 9: results.
    const summary = renderResults(session, outcome, sink);
    session.recordTurn(summary);
  }
}

function renderResults(
  session: OrchestratorSession,
  outcome: Awaited<ReturnType<Pipeline['execute']>>,
  sink: OutputSink,
): string {
  if (session.synthesis) {
    sink.markdown(`## Answer\n\n${session.reveal(session.synthesis)}\n\n---\n\n`);
  }

  sink.markdown('### Per-subtask results\n\n');
  for (const subtask of session.plan?.subtasks ?? []) {
    const skipped = outcome.skipped.find((entry) => entry.id === subtask.id);
    if (skipped) {
      sink.markdown(`- ⏭️ \`${subtask.id}\` skipped — ${skipped.reason}\n`);
      continue;
    }
    const result = outcome.results.get(subtask.id);
    if (!result) {
      continue;
    }
    sink.markdown(
      result.ok
        ? `- ✅ \`${subtask.id}\` on ${subtask.adapter}/${subtask.model} — ${formatUsd(result.cost.usd)}, ${formatTokens(result.cost.usage.outputTokens)} out\n`
        : `- ❌ \`${subtask.id}\` on ${subtask.adapter} — ${session.reveal(result.error ?? 'failed')}\n`,
    );
  }

  const findings = outcome.ledger.snapshot().entries.filter((entry) => entry.kind === 'finding');
  if (findings.length > 0) {
    sink.markdown('\n### Findings\n\n');
    for (const finding of findings.slice(0, 25)) {
      const refs = finding.refs.length > 0 ? ` — ${finding.refs.join(', ')}` : '';
      sink.markdown(`- ${session.reveal(finding.summary)}${refs}\n`);
    }
  }

  const edits = outcome.ledger.allEdits();
  if (edits.length > 0) {
    sink.markdown(
      `\n**${edits.length} proposed edit${edits.length === 1 ? '' : 's'}.** Nothing has been written to disk.\n\n`,
    );
    for (const edit of edits.slice(0, 20)) {
      sink.markdown(`- \`${edit.path}\` (from \`${edit.subtaskId}\`)\n`);
    }
    sink.button({
      command: 'orchestrator.reviewEdits',
      title: `Review ${edits.length} edit${edits.length === 1 ? '' : 's'}`,
      arguments: [edits],
    });
  }

  if (outcome.warnings.length > 0) {
    sink.markdown(`\n<details><summary>${outcome.warnings.length} warnings</summary>\n\n`);
    for (const warning of outcome.warnings.slice(0, 30)) {
      sink.markdown(`- ${session.reveal(warning)}\n`);
    }
    sink.markdown('\n</details>\n');
  }

  const ran = [...outcome.results.values()].filter((result) => result.ok).length;
  if (findings.length > 0) {
    return session.reveal(`${findings.length} finding(s): ${findings[0]?.summary ?? ''}`).slice(0, 200);
  }
  if (edits.length > 0) {
    return `proposed ${edits.length} edit(s) to ${[...new Set(edits.map((e) => e.path))].slice(0, 3).join(', ')}`;
  }
  return `${ran} subtask(s) completed`;
}

export function renderQuestions(sink: OutputSink, intake: IntakeOutcome): void {
  sink.markdown(
    `I need to check ${intake.questions.length === 1 ? 'one thing' : `${intake.questions.length} things`} ` +
      'before spending anything on an external model.\n\n',
  );
  for (const [index, question] of intake.questions.entries()) {
    sink.markdown(`**${index + 1}. ${question.question}**\n`);
    for (const option of question.options ?? []) {
      sink.markdown(`   - ${option}\n`);
    }
    sink.markdown(`   _If you skip this: ${question.assumptionIfSkipped}_\n\n`);
  }
  sink.markdown('Reply with your answers, or say **go** to accept the assumptions above.\n');
}

/**
 * Reads a free-text reply as answers. Numbered lines map to numbered questions;
 * anything else attaches to the first. Loose on purpose — a developer typing a
 * sentence should not have to learn a syntax to get past this gate.
 */
export function absorbAnswers(session: OrchestratorSession, reply: string): void {
  const questions = session.intake?.questions ?? [];
  const trimmed = reply.trim();

  if (/^(go|proceed|continue|yes|ok)\b/i.test(trimmed)) {
    return;
  }
  const numbered = [...trimmed.matchAll(/^\s*(\d+)[.):]\s*(.+)$/gm)];
  if (numbered.length > 0) {
    for (const match of numbered) {
      const question = questions[Number(match[1]) - 1];
      if (question && match[2]) {
        session.answers.push({ id: question.id, question: question.question, answer: match[2].trim() });
      }
    }
    return;
  }
  const first = questions[0];
  if (first) {
    session.answers.push({ id: first.id, question: first.question, answer: trimmed });
  }
}

/** Reads files the user attached, for the guard to redact and classify. */
export async function readReferenceUris(uris: vscode.Uri[]): Promise<string> {
  const parts: string[] = [];
  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) {
        continue;
      }
      const path = vscode.workspace.asRelativePath(uri, false);
      parts.push(`<attached path="${path}">\n${new TextDecoder().decode(bytes)}\n</attached>`);
    } catch {
      // Skip unreadable attachments; the turn still runs on the prompt.
    }
  }
  return parts.join('\n\n');
}
