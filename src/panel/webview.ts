import * as vscode from 'vscode';

/**
 * Shared webview plumbing.
 *
 * Panels here follow VS Code's theme variables rather than shipping their own
 * palette, so the tool does not look like a foreign object inside the editor.
 * A strict CSP with a per-load nonce blocks anything the panel did not author —
 * these panels display file paths and model output, which is exactly the sort
 * of content that should never be able to execute.
 */

export function nonce(): string {
  return Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
      Math.floor(Math.random() * 62),
    ),
  ).join('');
}

/** Escapes text before it reaches the DOM. Paths and model output are data. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const BASE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 16px 20px 96px;
    line-height: 1.5;
  }
  h1 { font-size: 1.25rem; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 1rem; margin: 24px 0 8px; font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
  th {
    text-align: left;
    font-weight: 600;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    position: sticky; top: 0;
    background: var(--vscode-editor-background);
  }
  td { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  code, .mono { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  .tier { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 0.82em; font-weight: 600; white-space: nowrap; }
  .tier-public      { background: rgba(90,160,90,.18);  color: var(--vscode-testing-iconPassed, #4caf50); }
  .tier-internal    { background: rgba(90,130,200,.18); color: var(--vscode-textLink-foreground); }
  .tier-confidential{ background: rgba(210,150,50,.20); color: var(--vscode-editorWarning-foreground); }
  .tier-restricted  { background: rgba(200,70,70,.20);  color: var(--vscode-editorError-foreground); }
  .muted { color: var(--vscode-descriptionForeground); }
  .warn {
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    background: var(--vscode-inputValidation-warningBackground, transparent);
    padding: 8px 12px; margin: 12px 0; border-radius: 0 3px 3px 0;
  }
  .danger {
    border-left: 3px solid var(--vscode-editorError-foreground);
    padding: 8px 12px; margin: 12px 0; border-radius: 0 3px 3px 0;
  }
  .actions {
    position: fixed; bottom: 0; left: 0; right: 0;
    padding: 12px 20px;
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--vscode-panel-border);
    display: flex; gap: 8px; align-items: center;
  }
  button {
    font-family: inherit; font-size: inherit;
    padding: 5px 14px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .spacer { flex: 1; }
  .stat { display: flex; gap: 28px; flex-wrap: wrap; margin: 12px 0 4px; }
  .stat div { min-width: 110px; }
  .stat .k { color: var(--vscode-descriptionForeground); font-size: .85em; }
  .stat .v { font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .pos { color: var(--vscode-testing-iconPassed, #4caf50); }
  .neg { color: var(--vscode-editorError-foreground); }
  input[type=checkbox] { accent-color: var(--vscode-button-background); }
  details { margin: 8px 0; }
  summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
`;

export function html(title: string, body: string, script: string, cspNonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${cspNonce}'; script-src 'nonce-${cspNonce}';">
<title>${esc(title)}</title>
<style nonce="${cspNonce}">${BASE_STYLE}</style>
</head>
<body>
${body}
<script nonce="${cspNonce}">${script}</script>
</body>
</html>`;
}

/**
 * A panel that asks a question and resolves once. Disposal counts as a
 * rejection — closing the window must never be read as approval.
 */
export class DecisionPanel<T> {
  private panel: vscode.WebviewPanel;
  private resolve?: (value: T | undefined) => void;
  private settled = false;

  constructor(
    viewType: string,
    title: string,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
  ) {
    this.panel = vscode.window.createWebviewPanel(viewType, title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });

    this.panel.onDidDispose(() => {
      if (!this.settled) {
        this.settled = true;
        this.resolve?.(undefined);
      }
    });
  }

  get webview(): vscode.Webview {
    return this.panel.webview;
  }

  setHtml(content: string): void {
    this.panel.webview.html = content;
  }

  reveal(): void {
    this.panel.reveal();
  }

  onMessage(handler: (message: any) => void): void {
    this.panel.webview.onDidReceiveMessage(handler);
  }

  settle(value: T | undefined): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve?.(value);
    this.panel.dispose();
  }

  wait(): Promise<T | undefined> {
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  dispose(): void {
    this.panel.dispose();
  }
}
