import * as vscode from 'vscode';
import { gaussConfig } from '../config.ts';
import type { AdapterRegistry } from '../exec/adapters/registry.ts';
import { OrchestratorSession, Pipeline } from '../pipeline.ts';
import { showReportPanel } from '../panel/ReportPanel.ts';
import { runTwoPhasePrecheck } from '../ui/precheck.ts';
import { ConversationController, readReferenceUris } from '../ui/controller.ts';
import type { OutputSink } from '../ui/sink.ts';
import { formatUsd } from '../optimize/tokens.ts';

const PARTICIPANT_ID = 'orchestrator.chat';

/**
 * `@orchestrator` — the native chat surface.
 *
 * A thin wrapper over the shared `ConversationController`: it turns a chat
 * request into a controller call and passes the response stream as the sink.
 * The dedicated sidebar panel wraps the same controller, so both surfaces run
 * the identical pipeline and gates.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  registry: AdapterRegistry,
  pipeline: Pipeline,
): vscode.Disposable {
  const controller = new ConversationController(pipeline);

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, chatContext, stream, token) => {
      if (!gaussConfig().baseUrl) {
        renderGaussSetup(stream);
        return;
      }

      switch (request.command) {
        case 'status':
          return await renderStatus(registry, stream);
        case 'report':
          return renderLastReport(controller.current(), pipeline, stream);
        case 'approvals':
          return renderApprovals(pipeline, stream);
        case 'audit':
          return await renderAudit(pipeline, stream);
        case 'precheck':
          return await runPrecheck(pipeline, stream, token);
      }

      // An empty history means VS Code opened a fresh chat → new conversation.
      const forceNew = (chatContext.history?.length ?? 0) === 0;
      const attached = await readReferenceUris(
        (request.references ?? [])
          .map((reference) => reference.value)
          .filter((value): value is vscode.Uri => value instanceof vscode.Uri),
      );

      await controller.handle(request.prompt, attached, stream as OutputSink, token, forceNew);
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

async function runPrecheck(
  pipeline: Pipeline,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const summary = await runTwoPhasePrecheck(pipeline, (message) => stream.progress(message), token);

  stream.markdown(
    `**Phase 1 (regex):** swept **${summary.scannedCount} files** free — ` +
      `**${summary.regexFlagged}** flagged` +
      `${summary.skipped > 0 ? `, ${summary.skipped} skipped (too large or binary)` : ''}.\n\n`,
  );
  if (summary.ranPhase2) {
    stream.markdown(
      `**Phase 2 (model):** classified the rest — **${summary.modelFlagged}** flagged` +
        `${summary.costUsd !== undefined ? ` ($${summary.costUsd.toFixed(4)})` : ''}. ` +
        'The map now shows both phases.\n',
    );
  } else {
    stream.markdown(
      '_Phase 2 (model) did not run — no planner configured, or it was cancelled. The regex map is shown._\n',
    );
  }
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
    'The planner is not configured, so I cannot plan.\n\n' +
      'Sweeping, clarification, context selection, classification, compilation, decomposition and routing all run ' +
      '**only** on the planner (Gauss, or a local stand-in). That is what keeps your workspace off external providers, ' +
      'so there is deliberately no fallback here.\n\n' +
      'Set `orchestrator.gauss.baseUrl` — a local model on localhost needs no key — then, for a hosted planner, run ' +
      '**Orchestrator: Set Gauss API Key**.',
  );
  stream.button({
    command: 'workbench.action.openSettings',
    title: 'Open Orchestrator settings',
    arguments: ['orchestrator.gauss'],
  });
}

async function renderStatus(registry: AdapterRegistry, stream: vscode.ChatResponseStream): Promise<void> {
  const probes = await registry.all();
  const gauss = gaussConfig();

  stream.markdown(`**Planner** — \`${gauss.baseUrl || 'not configured'}\`, model \`${gauss.model}\`.\n`);
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
      `${formatUsd(accounting.planning.reduce((sum, r) => sum + r.usd, 0))} of planning. ` +
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
