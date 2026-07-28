import * as vscode from 'vscode';
import { adapterBins, GAUSS_KEY_SECRET, gaussConfig } from './config.ts';
import { AdapterRegistry } from './exec/adapters/registry.ts';
import type { ProbeResult } from './exec/adapters/types.ts';
import { registerChatParticipant } from './chat/participant.ts';
import { Pipeline } from './pipeline.ts';
import { applyEdit, previewEdit } from './workspace.ts';
import { runTwoPhasePrecheck } from './ui/precheck.ts';
import { showReportPanel } from './panel/ReportPanel.ts';
import { SidebarViewProvider } from './panel/SidebarView.ts';

let output: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Orchestrator', { log: true });
  context.subscriptions.push(output);

  const registry = new AdapterRegistry(adapterBins);
  const pipeline = new Pipeline(context, registry);

  // The dedicated left-side panel (its own activity-bar icon), alongside the
  // native @orchestrator chat participant. Both drive the same pipeline.
  const sidebar = new SidebarViewProvider(context.extensionUri, pipeline);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('orchestrator.showAdapterStatus', () => showAdapterStatus(registry)),
    vscode.commands.registerCommand('orchestrator.setGaussApiKey', () => setGaussApiKey(context)),
    vscode.commands.registerCommand('orchestrator.clearGaussApiKey', async () => {
      await context.secrets.delete(GAUSS_KEY_SECRET);
      vscode.window.showInformationMessage('Orchestrator: Gauss API key cleared.');
    }),
    vscode.commands.registerCommand('orchestrator.revokeApprovals', () => revokeApprovals(pipeline)),
    vscode.commands.registerCommand('orchestrator.verifyAudit', () => verifyAudit(pipeline)),
    vscode.commands.registerCommand('orchestrator.precheckWorkspace', () => precheckWorkspace(pipeline)),
    vscode.commands.registerCommand('orchestrator.showLastReport', () => showLastReport(pipeline)),
    vscode.commands.registerCommand('orchestrator.reviewEdits', (edits: ProposedEdit[]) => reviewEdits(edits)),
    registerChatParticipant(context, registry, pipeline),
  );

  // Probe in the background. Activation must not block on three process spawns.
  void registry.refresh().then((results) => results.forEach(logProbe));
}

export function deactivate(): void {
  // Child processes are scoped to their run and killed via the runner's signal.
}

interface ProposedEdit {
  subtaskId: string;
  path: string;
  search: string;
  replace: string;
}

/**
 * Edits are reviewed as diffs and applied one at a time through the workspace
 * edit API, so every change lands in VS Code's undo stack. Nothing is written
 * without the user seeing it first.
 */
async function reviewEdits(edits: ProposedEdit[]): Promise<void> {
  if (!Array.isArray(edits) || edits.length === 0) {
    return;
  }

  for (const [index, edit] of edits.entries()) {
    await previewEdit(edit.path, edit.search, edit.replace);

    const choice = await vscode.window.showInformationMessage(
      `Edit ${index + 1} of ${edits.length}: ${edit.path} (from ${edit.subtaskId})`,
      { modal: false },
      'Apply',
      'Skip',
      'Stop',
    );

    if (choice === 'Stop' || choice === undefined) {
      return;
    }
    if (choice === 'Skip') {
      continue;
    }

    const result = await applyEdit(edit.path, edit.search, edit.replace);
    if (!result.ok) {
      await vscode.window.showWarningMessage(`Could not apply edit to ${edit.path}: ${result.reason}`);
    }
  }
}

function showLastReport(pipeline: Pipeline): void {
  const session = pipeline.lastSession;
  const report = session ? pipeline.buildReport(session) : undefined;
  const accounting = session ? pipeline.accountingFor(session) : undefined;
  if (!report || !accounting || !session?.plan || !session.outcome) {
    vscode.window.showInformationMessage('Orchestrator: no completed run yet — run a request first.');
    return;
  }
  showReportPanel(report, session.plan, accounting, session.outcome.contextTokensSaved);
}

async function precheckWorkspace(pipeline: Pipeline): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Prechecking workspace…', cancellable: true },
    (report, token) =>
      runTwoPhasePrecheck(pipeline, (message) => report.report({ message }), token),
  );
}

async function verifyAudit(pipeline: Pipeline): Promise<void> {
  const result = await pipeline.verifyAudit();
  const message = `Audit log: ${result.count} record${result.count === 1 ? '' : 's'}. ${result.detail}`;
  if (result.ok) {
    vscode.window.showInformationMessage(message);
  } else {
    // A broken chain is a compliance event, not a warning to dismiss.
    vscode.window.showErrorMessage(message, { modal: true });
  }
}

async function revokeApprovals(pipeline: Pipeline): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Revoke every file approval in this workspace?',
    { modal: true, detail: 'All files return to Gauss-only until you approve them again.' },
    'Revoke all',
  );
  if (confirm === 'Revoke all') {
    await pipeline.approvals.revokeAll();
    vscode.window.showInformationMessage('Orchestrator: all file approvals revoked.');
  }
}

function logProbe(result: ProbeResult): void {
  const version = result.version ? ` (${result.version})` : '';
  const line = `${result.adapter}${version}: ${result.status}`;
  if (result.status === 'ready') {
    output.info(line);
  } else {
    output.warn(line);
  }
  for (const note of result.notes) {
    output.warn(`  ${result.adapter}: ${note}`);
  }
}

const STATUS_ICON = {
  ready: '$(check)',
  degraded: '$(warning)',
  unavailable: '$(error)',
} as const;

async function showAdapterStatus(registry: AdapterRegistry): Promise<void> {
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Probing model CLIs…' },
    () => registry.refresh(),
  );

  const gauss = gaussConfig();
  const items: vscode.QuickPickItem[] = [
    {
      label: gauss.baseUrl ? '$(check) gauss' : '$(error) gauss',
      description: gauss.baseUrl || 'not configured',
      detail: gauss.baseUrl
        ? `All planning runs here. Model: ${gauss.model}`
        : 'Set orchestrator.gauss.baseUrl. Without it nothing can run — planning is the only stage allowed to see unreviewed workspace content.',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    ...results.map((result) => ({
      label: `${STATUS_ICON[result.status]} ${result.adapter}`,
      description: result.version ?? result.bin,
      detail: result.notes.length > 0 ? result.notes.join(' ') : capabilitySummary(result),
    })),
  ];

  await vscode.window.showQuickPick(items, {
    title: 'Orchestrator — model adapter status',
    placeHolder: 'Planning is Gauss-only. These adapters execute approved subtasks.',
  });
}

function capabilitySummary(result: ProbeResult): string {
  const enabled = Object.entries(result.capabilities)
    .filter(([, on]) => on)
    .map(([name]) => name);
  return enabled.length > 0 ? enabled.join(', ') : 'no capabilities detected';
}

async function setGaussApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'Gauss API key',
    prompt: 'Stored in VS Code SecretStorage, never written to settings or logs.',
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) {
    return;
  }
  await context.secrets.store(GAUSS_KEY_SECRET, key);
  vscode.window.showInformationMessage('Orchestrator: Gauss API key saved.');
}
