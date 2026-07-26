/**
 * Where a turn writes its output.
 *
 * The whole pipeline flow — sweep, clarify, plan, results — is written once
 * against this interface, so it can drive both surfaces: VS Code's native chat
 * (the `@orchestrator` participant) and the dedicated sidebar webview.
 *
 * `vscode.ChatResponseStream` already has `markdown`, `progress` and `button`
 * with these shapes, so the participant passes its stream directly. The sidebar
 * supplies a `WebviewSink` that posts messages to its webview instead.
 */
export interface OutputSink {
  /** Append markdown to the transcript. */
  markdown(md: string): void;
  /** Show a transient progress line ("Planning on Gauss…"). */
  progress(message: string): void;
  /** Offer a command button (e.g. "Review 2 edits"). */
  button(button: { command: string; title: string; arguments?: unknown[] }): void;
}
