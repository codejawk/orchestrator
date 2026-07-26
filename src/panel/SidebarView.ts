import * as vscode from 'vscode';
import { gaussConfig } from '../config.ts';
import type { Pipeline } from '../pipeline.ts';
import { ConversationController } from '../ui/controller.ts';
import type { OutputSink } from '../ui/sink.ts';
import { esc, nonce } from './webview.ts';

/**
 * The dedicated Orchestrator panel in the activity bar — the Cline-style
 * left-side surface.
 *
 * It is a thin transcript-plus-input webview over the same `ConversationController`
 * the native chat participant uses, so both surfaces run the identical pipeline
 * and the identical security gates. The heavyweight approval steps still pop the
 * existing Review and Plan panels; this view owns only the conversation.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'orchestrator.chatView';

  private readonly extensionUri: vscode.Uri;
  private readonly controller: ConversationController;
  private view?: vscode.WebviewView;
  private running?: vscode.CancellationTokenSource;

  constructor(extensionUri: vscode.Uri, pipeline: Pipeline) {
    this.extensionUri = extensionUri;
    this.controller = new ConversationController(pipeline);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: InboundMessage) => {
      switch (message.type) {
        case 'send':
          void this.onSend(message.text);
          break;
        case 'new':
          this.controller.reset();
          this.post({ type: 'cleared' });
          break;
        case 'cancel':
          this.running?.cancel();
          break;
        case 'command':
          void vscode.commands.executeCommand(message.command, ...(message.arguments ?? []));
          break;
        case 'ready':
          this.postPlanner();
          break;
      }
    });

    // Keep the "planner not configured" banner in sync with settings, instead of
    // baking it into the HTML once. Changing orchestrator.gauss.baseUrl updates
    // it live, and it re-checks whenever the panel becomes visible again.
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('orchestrator.gauss')) {
        this.postPlanner();
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postPlanner();
      }
    });
    view.onDidDispose(() => cfgSub.dispose());
  }

  private postPlanner(): void {
    this.post({ type: 'planner', configured: Boolean(gaussConfig().baseUrl) });
  }

  /** Focuses the view and can be called from a command. */
  reveal(): void {
    this.view?.show?.(true);
  }

  private async onSend(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) {
      return;
    }
    if (!gaussConfig().baseUrl) {
      this.post({ type: 'assistant', html: this.md(GAUSS_SETUP) });
      return;
    }

    this.post({ type: 'user', html: esc(prompt) });
    this.post({ type: 'busy', busy: true });

    this.running?.cancel();
    this.running = new vscode.CancellationTokenSource();
    const sink = this.makeSink();

    try {
      await this.controller.handle(prompt, '', sink, this.running.token);
    } catch (error) {
      this.post({ type: 'assistant', html: this.md(`**Stopped.** ${error instanceof Error ? error.message : String(error)}`) });
    } finally {
      this.post({ type: 'progress', text: '' });
      this.post({ type: 'busy', busy: false });
      // Self-correct the banner: a run that reached here proves the planner is
      // reachable, so make sure the "not configured" notice is not lingering.
      this.postPlanner();
    }
  }

  /** Bridges the pipeline's OutputSink onto webview messages. */
  private makeSink(): OutputSink {
    return {
      markdown: (md) => this.post({ type: 'assistant', html: this.md(md) }),
      progress: (message) => this.post({ type: 'progress', text: message }),
      button: (button) => this.post({ type: 'button', command: button.command, title: button.title, arguments: button.arguments }),
    };
  }

  private post(message: OutboundMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /**
   * A deliberately small markdown-to-HTML pass. It escapes first, then applies a
   * handful of safe transforms — enough for the transcript, without pulling in a
   * full markdown library or its injection surface.
   */
  private md(text: string): string {
    const lines = esc(text).split('\n');
    const out: string[] = [];
    let inList = false;
    const closeList = () => {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
    };

    for (const raw of lines) {
      const line = raw
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\b_([^_]+)_\b/g, '<em>$1</em>');

      if (/^## /.test(line)) {
        closeList();
        out.push(`<h3>${line.slice(3)}</h3>`);
      } else if (/^### /.test(line)) {
        closeList();
        out.push(`<h4>${line.slice(4)}</h4>`);
      } else if (/^&gt; /.test(line)) {
        closeList();
        out.push(`<blockquote>${line.slice(5)}</blockquote>`);
      } else if (/^- /.test(line)) {
        if (!inList) {
          out.push('<ul>');
          inList = true;
        }
        out.push(`<li>${line.slice(2)}</li>`);
      } else if (/^---$/.test(line.trim())) {
        closeList();
        out.push('<hr>');
      } else if (line.trim() === '') {
        closeList();
        out.push('<br>');
      } else {
        closeList();
        out.push(`<div>${line}</div>`);
      }
    }
    closeList();
    return out.join('');
  }

  private html(webview: vscode.Webview): string {
    const cspNonce = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${cspNonce}'; script-src 'nonce-${cspNonce}';">
<style nonce="${cspNonce}">
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
    display: flex; flex-direction: column; height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  header .title { font-weight: 600; flex: 1; }
  header button {
    background: none; border: none; color: var(--vscode-descriptionForeground);
    cursor: pointer; font-size: 0.85em; padding: 2px 6px; border-radius: 3px;
  }
  header button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .msg { margin-bottom: 14px; line-height: 1.5; }
  .msg.user { border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 10px; opacity: .9; }
  .msg.assistant h3 { font-size: 1.05em; margin: 12px 0 4px; }
  .msg.assistant h4 { font-size: .95em; margin: 10px 0 3px; color: var(--vscode-descriptionForeground); }
  .msg.assistant blockquote {
    margin: 6px 0; padding: 4px 10px; border-left: 2px solid var(--vscode-editorWarning-foreground);
    color: var(--vscode-descriptionForeground);
  }
  .msg.assistant ul { margin: 4px 0; padding-left: 18px; }
  .msg.assistant code { font-family: var(--vscode-editor-font-family); font-size: .92em; }
  .msg.assistant hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
  .cmd-btn {
    display: inline-block; margin: 6px 0;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; padding: 4px 12px; cursor: pointer; font: inherit;
  }
  .cmd-btn:hover { background: var(--vscode-button-hoverBackground); }
  #progress { padding: 0 12px; height: 18px; color: var(--vscode-descriptionForeground); font-size: .85em; font-style: italic; }
  .notice { padding: 8px 12px; color: var(--vscode-editorWarning-foreground); font-size: .9em; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; }
  #input {
    width: 100%; box-sizing: border-box; resize: none; min-height: 52px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
    padding: 8px; font: inherit;
  }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .row button {
    flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 6px; cursor: pointer; font: inherit;
  }
  .row button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .row button:disabled { opacity: .5; cursor: default; }
  .empty { color: var(--vscode-descriptionForeground); padding: 20px 12px; text-align: center; font-size: .9em; }
</style>
</head>
<body>
  <header>
    <span class="title">Orchestrator</span>
    <button id="precheck" title="Scan the workspace security map">Precheck</button>
    <button id="new" title="Start a new conversation">New</button>
  </header>
  <div id="planner-notice" class="notice" style="display:none">Planner not configured. Set <code>orchestrator.gauss.baseUrl</code> (a local model on localhost needs no key) to begin.</div>
  <div id="log"><div class="empty">Ask about your code. I plan on Gauss, route subtasks to the cheapest capable model, and never send anything you haven't approved.</div></div>
  <div id="progress"></div>
  <footer>
    <textarea id="input" placeholder="Describe what you want… (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="row">
      <button id="send">Send</button>
      <button id="stop" class="secondary" disabled>Stop</button>
    </div>
  </footer>
<script nonce="${cspNonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const stop = document.getElementById('stop');
  const progress = document.getElementById('progress');
  let assistantEl = null;

  function clearEmpty() { const e = log.querySelector('.empty'); if (e) e.remove(); }

  function addUser(html) {
    clearEmpty();
    const d = document.createElement('div'); d.className = 'msg user'; d.innerHTML = html;
    log.appendChild(d); log.scrollTop = log.scrollHeight; assistantEl = null;
  }
  function appendAssistant(html) {
    clearEmpty();
    if (!assistantEl) { assistantEl = document.createElement('div'); assistantEl.className = 'msg assistant'; log.appendChild(assistantEl); }
    assistantEl.insertAdjacentHTML('beforeend', html);
    log.scrollTop = log.scrollHeight;
  }
  function addButton(command, title, args) {
    const b = document.createElement('button'); b.className = 'cmd-btn'; b.textContent = title;
    b.onclick = () => vscode.postMessage({ type: 'command', command, arguments: args });
    (assistantEl || log).appendChild(b); log.scrollTop = log.scrollHeight;
  }

  function setBusy(busy) {
    send.disabled = busy; input.disabled = busy; stop.disabled = !busy;
    if (!busy) { assistantEl = null; input.focus(); }
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    addUser(text.replace(/</g,'&lt;'));
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  }

  send.onclick = submit;
  stop.onclick = () => vscode.postMessage({ type: 'cancel' });
  document.getElementById('new').onclick = () => vscode.postMessage({ type: 'new' });
  document.getElementById('precheck').onclick = () => vscode.postMessage({ type: 'command', command: 'orchestrator.precheckWorkspace' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'user') addUser(m.html);
    else if (m.type === 'assistant') appendAssistant(m.html);
    else if (m.type === 'button') addButton(m.command, m.title, m.arguments);
    else if (m.type === 'progress') progress.textContent = m.text || '';
    else if (m.type === 'busy') setBusy(m.busy);
    else if (m.type === 'cleared') { log.innerHTML = '<div class="empty">New conversation. The workspace scan will run fresh.</div>'; assistantEl = null; }
    else if (m.type === 'planner') { document.getElementById('planner-notice').style.display = m.configured ? 'none' : 'block'; }
  });
  vscode.postMessage({ type: 'ready' });
  input.focus();
</script>
</body>
</html>`;
  }
}

interface SendMessage { type: 'send'; text: string }
interface NewMessage { type: 'new' }
interface CancelMessage { type: 'cancel' }
interface CommandMessage { type: 'command'; command: string; arguments?: unknown[] }
interface ReadyMessage { type: 'ready' }
type InboundMessage = SendMessage | NewMessage | CancelMessage | CommandMessage | ReadyMessage;

type OutboundMessage =
  | { type: 'user'; html: string }
  | { type: 'assistant'; html: string }
  | { type: 'button'; command: string; title: string; arguments?: unknown[] }
  | { type: 'progress'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'cleared' }
  | { type: 'planner'; configured: boolean };

const GAUSS_SETUP =
  'The planner is not configured, so I cannot plan.\n\n' +
  'Set `orchestrator.gauss.baseUrl`. A local model on localhost (Ollama, LM Studio) needs no key and works as a stand-in until Gauss is connected.';
