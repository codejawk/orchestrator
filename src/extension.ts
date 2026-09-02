import * as vscode from 'vscode';
import { OrchestratorView } from './sidebar.ts';

export function activate(context: vscode.ExtensionContext): void {
  const view = new OrchestratorView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OrchestratorView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}
