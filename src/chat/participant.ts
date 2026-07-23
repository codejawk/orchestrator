import * as vscode from 'vscode';
import { gaussConfig, policyConfig } from '../config.ts';
import type { AdapterRegistry } from '../exec/adapters/registry.ts';
import { OrchestratorSession, Pipeline } from '../pipeline.ts';
import { showReviewPanel } from '../panel/ReviewPanel.ts';
import { showPlanPanel } from '../panel/PlanPanel.ts';
import { showReportPanel } from '../panel/ReportPanel.ts';
import { formatTokens, formatUsd } from '../optimize/tokens.ts';
import type { RunnerEvent } from '../exec/runner.ts';
import type { FileVerdict } from '../planner/scanner.ts';

const PARTICIPANT_ID = 'orchestrator.chat';

/**
 * `@orchestrator` — the front door.
 *
 * Runs the whole pipeline in one turn where it can, because a tool that needs
 * four round trips before it starts will lose to pasting into a browser tab.
 * The one place it deliberately stops is clarification: when a request is
 * ambiguous the turn ends with questions and the next message is read as
 * answers. That pause is the product, not an interruption to it.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  registry: AdapterRegistry,
  pipeline: Pipeline,
): vscode.Disposable {
  // One live conversation at a time, like a chat panel. A turn awaiting
  // clarification answers is tracked separately so the next message is read as
  // answers rather than a new request.
  let conversation: OrchestratorSession | undefined;
  let awaitingAnswers: OrchestratorSession | undefined;

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, chatContext, stream, token) => {
      if (!gaussConfig().baseUrl) {
        renderGaussSetup(stream);
        return;
      }

      try {
        switch (request.command) {
          case 'status':
            return await renderStatus(registry, stream);
          case 'report':
            return renderLastReport(conversation, pipeline, stream);
          case 'approvals':
            return renderApprovals(pipeline, stream);
          case 'audit':
            return await renderAudit(pipeline, stream);
        }

        // A reply to clarifying questions continues that same turn.
        if (awaitingAnswers) {
          const session = awaitingAnswers;
          awaitingAnswers = undefined;
          absorbAnswers(session, request.prompt);
          stream.markdown('Thanks — using that.\n\n');
          await runTurn(session, pipeline, stream, token);
          return;
        }

        // Continuity: an empty history means VS Code opened a fresh chat, so we
        // start a new conversation. Otherwise this is a follow-up and we keep the
        // workspace scan, the accumulated taint and the turn history.
        const isFollowUp = (chatContext.history?.length ?? 0) > 0 && conversation !== undefined;
        const session = isFollowUp ? conversation! : new OrchestratorSession(`c-${Date.now()}`);
        conversation = session;
        session.startTurn();
        pipeline.resetGauss();

        if (isFollowUp) {
          stream.markdown(
            `_Follow-up in this conversation — ${session.turns.length} prior turn${session.turns.length === 1 ? '' : 's'}, reusing the workspace scan._\n\n`,
          );
        }

        // -- Stage 0: guard what the user typed or dragged in ----------------
        const attached = await readReferences(request, stream);
        const assessment = pipeline.guardPrompt(session, request.prompt, attached);
        if (assessment.summary) {
          stream.markdown(`> ${assessment.summary}\n\n`);
        }

        // -- Stage 1: sweep, but only the first time in a conversation --------
        if (session.needsSweep) {
          stream.progress('Sweeping the workspace…');
          const sweep = await pipeline.sweep(session, undefined, token);
          if (sweep.totalFiles === 0) {
            stream.markdown('No readable source files found in this workspace.');
            return;
          }
          stream.markdown(
            `Swept **${sweep.totalFiles} files** at no cost. ` +
              `${sweep.restricted.length} matched a restricted pattern and are excluded from external use entirely` +
              `${sweep.restricted.length > 0 ? ` (${sweep.restricted.slice(0, 3).map((p) => `\`${p}\``).join(', ')}${sweep.restricted.length > 3 ? ', …' : ''})` : ''}.\n\n`,
          );
        }

        // -- Stage 2: clarify -------------------------------------------------
        stream.progress('Checking the request is clear enough to act on…');
        const intake = await pipeline.intake(session, token);

        if (intake.questions.length > 0) {
          renderQuestions(stream, intake);
          awaitingAnswers = session;
          return;
        }
        if (intake.restatedGoal) {
          stream.markdown(`Understood as: _${session.reveal(intake.restatedGoal)}_\n\n`);
        }

        await runTurn(session, pipeline, stream, token);
      } catch (error) {
        stream.markdown(`\n\n**Stopped.** ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  participant.iconPath = new vscode.ThemeIcon('circuit-board');
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: '', label: 'Which models are available?', command: 'status' },
        { prompt: '', label: 'Show the last savings report', command: 'report' },
      ];
    },
  };

  context.subscriptions.push(participant);
  void registry.all();
  return participant;
}

/**
 * Everything from context selection onwards. Reached directly, on the turn after
 * clarifying questions were answered, and on every follow-up turn.
 */
async function runTurn(
  session: OrchestratorSession,
  pipeline: Pipeline,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  // -- Stages 3 and 4: select the relevant files, classify only those --------
  stream.progress('Choosing relevant files…');
  const { report, excludedBySweep, warnings } = await pipeline.selectAndScan(
    session,
    (message) => stream.progress(message),
    token,
  );

  if (report.files.length === 0) {
    stream.markdown(
      'No files were selected as relevant. Try naming the module or file you mean.\n\n' +
        (excludedBySweep.length > 0
          ? `_${excludedBySweep.length} file(s) were excluded by the restricted-pattern sweep and were never offered to the selector._`
          : ''),
    );
    return;
  }

  const scanUsd = report.costs.reduce((sum, record) => sum + record.usd, 0);
  stream.markdown(
    `Selected and classified **${report.files.length} file${report.files.length === 1 ? '' : 's'}** ` +
      `out of ${session.files.length} in the workspace — ${formatUsd(scanUsd)}.\n\n`,
  );

  // -- Stage 5: review ------------------------------------------------------
  if (session.taint.isTainted) {
    stream.markdown(
      `> **This run is pinned to Gauss.** ${session.taint.explanation}\n\n` +
        'No file review is needed — nothing is going to an external model either way.\n\n',
    );
  } else {
    // Only files not already decided this conversation need a decision.
    // Approvals persist by content hash, so a follow-up rarely re-opens the
    // panel — and never for files the user already ruled on.
    const pending = pipeline.pendingReview(report);

    if (pending.length === 0) {
      stream.markdown('_All selected files were already reviewed earlier in this conversation._\n\n');
    } else {
      stream.markdown(
        `Opening the review panel for **${pending.length} file${pending.length === 1 ? '' : 's'}** not yet decided. ` +
          '**Nothing leaves the network until you approve it.**\n\n',
      );
      const decision = await showReviewPanel(report, pipeline.approvals, policyConfig().allowRestrictedOverride);

      if (!decision) {
        stream.markdown('Review cancelled — nothing was sent anywhere.');
        return;
      }

      const byPath = new Map(report.files.map((file) => [file.path, file]));
      const pick = (paths: string[]): FileVerdict[] =>
        paths.map((path) => byPath.get(path)).filter((file): file is FileVerdict => Boolean(file));

      const allowed = await pipeline.recordApprovals(pick(decision.externalAllowed), 'external-allowed');
      await pipeline.recordApprovals(pick(decision.gaussOnly), 'gauss-only');

      stream.markdown(
        `**${allowed.applied}** approved for external models, **${decision.gaussOnly.length}** staying on Gauss.\n\n`,
      );
      for (const reason of allowed.rejected.slice(0, 3)) {
        stream.markdown(`> ${reason}\n\n`);
      }
    }
  }

  // -- Stage 6: plan --------------------------------------------------------
  stream.progress('Planning on Gauss…');
  const { plan, warnings: planWarnings, compression } = await pipeline.buildPlan(
    session,
    (message) => stream.progress(message),
    token,
  );

  if (plan.subtasks.length === 0) {
    stream.markdown('Planning produced no subtasks. Try rephrasing the request.');
    return;
  }

  const compressed = Math.round((1 - compression.after / Math.max(1, compression.before)) * 100);
  stream.markdown(
    `Planned **${plan.subtasks.length} subtask${plan.subtasks.length === 1 ? '' : 's'}**, ` +
      `prompt compressed ${compressed}%, forecast ${formatUsd(plan.estimate.usd)}.\n\n`,
  );

  // -- Stage 7: approve -----------------------------------------------------
  const approval = await showPlanPanel(plan, [...warnings, ...planWarnings], compression);
  if (!approval?.approved) {
    stream.markdown('Plan rejected — nothing ran.');
    return;
  }
  if (approval.excluded.length > 0) {
    plan.subtasks = plan.subtasks.filter((subtask) => !approval.excluded.includes(subtask.id));
    session.plan = plan;
  }

  // -- Stage 8: execute -----------------------------------------------------
  const started = new Set<string>();
  const outcome = await pipeline.execute(
    session,
    (event: RunnerEvent) => {
      if (event.type === 'subtask-start' && !started.has(event.subtask.id)) {
        started.add(event.subtask.id);
        stream.progress(`${event.subtask.id} → ${event.subtask.adapter}/${event.subtask.model}`);
      }
    },
    token,
  );

  // -- Stage 9: results and report -----------------------------------------
  const summary = renderResults(session, outcome, stream);

  // Record the turn so a later "now the fuel gauge too" is planned in context.
  // The summary is a single line — never raw output — matching the ledger's
  // summaries-not-transcripts discipline.
  session.recordTurn(summary);
}

function renderResults(
  session: OrchestratorSession,
  outcome: Awaited<ReturnType<Pipeline['execute']>>,
  stream: vscode.ChatResponseStream,
): string {
  stream.markdown('### Results\n\n');

  for (const subtask of session.plan?.subtasks ?? []) {
    const skipped = outcome.skipped.find((entry) => entry.id === subtask.id);
    if (skipped) {
      stream.markdown(`- ⏭️ \`${subtask.id}\` skipped — ${skipped.reason}\n`);
      continue;
    }
    const result = outcome.results.get(subtask.id);
    if (!result) {
      continue;
    }
    stream.markdown(
      result.ok
        ? `- ✅ \`${subtask.id}\` on ${subtask.adapter}/${subtask.model} — ${formatUsd(result.cost.usd)}, ${formatTokens(result.cost.usage.outputTokens)} out\n`
        : `- ❌ \`${subtask.id}\` on ${subtask.adapter} — ${session.reveal(result.error ?? 'failed')}\n`,
    );
  }

  const findings = outcome.ledger.snapshot().entries.filter((entry) => entry.kind === 'finding');
  if (findings.length > 0) {
    stream.markdown('\n### Findings\n\n');
    for (const finding of findings.slice(0, 25)) {
      const refs = finding.refs.length > 0 ? ` — ${finding.refs.join(', ')}` : '';
      // reveal() puts redacted identifiers back: the model never saw the real
      // serial, but the person reading the finding needs it.
      stream.markdown(`- ${session.reveal(finding.summary)}${refs}\n`);
    }
  }

  const edits = outcome.ledger.allEdits();
  if (edits.length > 0) {
    stream.markdown(
      `\n**${edits.length} proposed edit${edits.length === 1 ? '' : 's'}.** Nothing has been written to disk.\n\n`,
    );
    for (const edit of edits.slice(0, 20)) {
      stream.markdown(`- \`${edit.path}\` (from \`${edit.subtaskId}\`)\n`);
    }
    stream.button({
      command: 'orchestrator.reviewEdits',
      title: `Review ${edits.length} edit${edits.length === 1 ? '' : 's'}`,
      arguments: [edits],
    });
  }

  if (outcome.warnings.length > 0) {
    stream.markdown(`\n<details><summary>${outcome.warnings.length} warnings</summary>\n\n`);
    for (const warning of outcome.warnings.slice(0, 30)) {
      stream.markdown(`- ${session.reveal(warning)}\n`);
    }
    stream.markdown('\n</details>\n');
  }

  // A one-line recap for the conversation history. Findings first, then edits,
  // then a bare completion — whatever best describes what this turn produced.
  const ran = [...outcome.results.values()].filter((result) => result.ok).length;
  if (findings.length > 0) {
    return session.reveal(`${findings.length} finding(s): ${findings[0]?.summary ?? ''}`).slice(0, 200);
  }
  if (edits.length > 0) {
    return `proposed ${edits.length} edit(s) to ${[...new Set(edits.map((e) => e.path))].slice(0, 3).join(', ')}`;
  }
  return `${ran} subtask(s) completed`;
}

/**
 * Reads files the user dragged into the chat box.
 *
 * These matter for exactly the reason the whole guard exists: a developer
 * attaching `dumpstate.txt` is handing over the file most likely to carry
 * identifiers, and it never went through the workspace scan.
 */
async function readReferences(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<string> {
  const parts: string[] = [];

  for (const reference of request.references ?? []) {
    const value = reference.value;
    if (!(value instanceof vscode.Uri)) {
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(value);
      if (bytes.includes(0)) {
        continue;
      }
      const path = vscode.workspace.asRelativePath(value, false);
      parts.push(`<attached path="${path}">\n${new TextDecoder().decode(bytes)}\n</attached>`);
    } catch {
      stream.markdown(`_Could not read attachment ${reference.id}._\n\n`);
    }
  }

  return parts.join('\n\n');
}

function renderQuestions(
  stream: vscode.ChatResponseStream,
  intake: {
    questions: { question: string; options?: string[]; assumptionIfSkipped: string }[];
    ambiguityScore: number;
  },
): void {
  stream.markdown(
    `I need to check ${intake.questions.length === 1 ? 'one thing' : `${intake.questions.length} things`} ` +
      'before spending anything on an external model.\n\n',
  );
  for (const [index, question] of intake.questions.entries()) {
    stream.markdown(`**${index + 1}. ${question.question}**\n`);
    for (const option of question.options ?? []) {
      stream.markdown(`   - ${option}\n`);
    }
    stream.markdown(`   _If you skip this: ${question.assumptionIfSkipped}_\n\n`);
  }
  stream.markdown('Reply with your answers, or say **go** to accept the assumptions above.\n');
}

/**
 * Reads a free-text reply as answers. Numbered lines map to numbered questions;
 * anything else attaches to the first. Loose on purpose — a developer typing a
 * sentence should not have to learn a syntax to get past this gate.
 */
function absorbAnswers(session: OrchestratorSession, reply: string): void {
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

async function renderStatus(registry: AdapterRegistry, stream: vscode.ChatResponseStream): Promise<void> {
  const probes = await registry.all();
  const gauss = gaussConfig();

  stream.markdown(`**Gauss** — \`${gauss.baseUrl || 'not configured'}\`, model \`${gauss.model}\`.\n`);
  stream.markdown('_All planning runs here. Nothing else is permitted to see unreviewed workspace content._\n\n');
  stream.markdown('**Execution adapters**\n\n');

  for (const probe of probes) {
    const mark = probe.status === 'ready' ? '✅' : probe.status === 'degraded' ? '⚠️' : '❌';
    stream.markdown(`- ${mark} \`${probe.adapter}\` ${probe.version ?? ''} — ${probe.status}\n`);
    for (const note of probe.notes) {
      stream.markdown(`  - ${note}\n`);
    }
  }
  stream.button({ command: 'orchestrator.showAdapterStatus', title: 'Re-probe CLIs' });
}

function renderLastReport(
  session: OrchestratorSession | undefined,
  pipeline: Pipeline,
  stream: vscode.ChatResponseStream,
): void {
  const report = session ? pipeline.buildReport(session) : undefined;
  const accounting = session ? pipeline.accountingFor(session) : undefined;

  if (!report || !accounting || !session?.plan || !session.outcome) {
    stream.markdown('No completed run in this session yet.');
    return;
  }

  stream.markdown(
    `Actual **${formatUsd(report.actualUsd)}** including ` +
      `${formatUsd(accounting.planning.reduce((sum, r) => sum + r.usd, 0))} of Gauss planning. ` +
      `Modelled baseline ${formatUsd(report.baseline.usd)}, ` +
      `net ${report.netUsd >= 0 ? 'saving' : 'overspend'} **${formatUsd(Math.abs(report.netUsd))}**.\n\n`,
  );
  showReportPanel(report, session.plan, accounting, session.outcome.contextTokensSaved);
}

function renderApprovals(pipeline: Pipeline, stream: vscode.ChatResponseStream): void {
  const approvals = pipeline.approvals.all();
  if (approvals.length === 0) {
    stream.markdown('No files are approved for external use in this workspace.');
    return;
  }

  const external = approvals.filter((a) => a.decision === 'external-allowed');
  stream.markdown(`**${external.length}** file${external.length === 1 ? '' : 's'} approved for external models:\n\n`);
  for (const approval of external.slice(0, 50)) {
    stream.markdown(
      `- \`${approval.path}\` — ${approval.tierAtApproval}${approval.override ? ' **(restricted override)**' : ''}, ${approval.at.slice(0, 10)}\n`,
    );
  }
  stream.button({ command: 'orchestrator.revokeApprovals', title: 'Revoke all approvals' });
}

async function renderAudit(pipeline: Pipeline, stream: vscode.ChatResponseStream): Promise<void> {
  const result = await pipeline.verifyAudit();
  const mark = result.ok ? '✅' : '❌';
  stream.markdown(
    `${mark} **Audit log** — ${result.count} record${result.count === 1 ? '' : 's'}.\n\n${result.detail}\n\n`,
  );
  if (!result.ok) {
    stream.markdown(
      '> A broken chain means the log was altered after the fact. Records store only salted hashes of prompts and responses, never plaintext.\n',
    );
  }
  stream.button({ command: 'orchestrator.verifyAudit', title: 'Re-verify integrity' });
}

function renderGaussSetup(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    'Gauss is not configured, so I cannot plan.\n\n' +
      'Sweeping, clarification, context selection, classification, compilation, decomposition and routing all run ' +
      '**only** on Gauss. That is what keeps your workspace off external providers, so there is deliberately no ' +
      'fallback here.\n\n' +
      'Set `orchestrator.gauss.baseUrl`, then run **Orchestrator: Set Gauss API Key**.',
  );
  stream.button({
    command: 'workbench.action.openSettings',
    title: 'Open Orchestrator settings',
    arguments: ['orchestrator.gauss'],
  });
}
