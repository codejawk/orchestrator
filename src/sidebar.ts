import * as vscode from 'vscode';
import { parseFiles, writeFiles, writeLogs } from './artifacts.ts';
import { clampEffort, findModel } from './catalog.ts';
import { decompose, synthesize, type MainModel } from './planner.ts';
import { executePlan, type RunnerContext } from './runner.ts';
import { spawnEnv } from './env.ts';
import { readUsage } from './usage.ts';
import type { UsageHeadroom } from './router.ts';
import type { Effort, Plan, SubtaskResult } from './types.ts';

/**
 * The whole UI: one webview in the activity bar that walks the seven steps —
 * type a prompt, see the plan with a model per subtask, press Run, watch each
 * subtask run on its model, read the combined result.
 */
export class OrchestratorView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'orchestratorMvp.view';

  private view?: vscode.WebviewView;
  private plan?: Plan;
  private running?: AbortController;
  private readonly output = vscode.window.createOutputChannel('Orchestrator MVP');

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(this.output);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  private cfg() {
    const c = vscode.workspace.getConfiguration('orchestratorMvp');
    const requestedMainModel = c.get<string>('mainModel', 'claude-opus-4-8');
    const mainEntry = findModel('claude', requestedMainModel) ?? findModel('claude', 'claude-opus-4-8')!;
    const requestedMainEffort = asEffort(c.get<string>('mainEffort', 'high')) ?? 'high';
    return {
      mainModel: mainEntry.id,
      mainEffort: clampEffort(mainEntry, requestedMainEffort),
      claudeBin: c.get<string>('claudePath', 'claude'),
      codexBin: c.get<string>('codexPath', 'codex'),
      timeoutMs: c.get<number>('timeoutSeconds', 240) * 1000,
    };
  }

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: { type: string; prompt?: string }): Promise<void> {
    if (msg.type === 'analyze') {
      await this.analyze(msg.prompt ?? '');
    } else if (msg.type === 'run') {
      await this.run();
    } else if (msg.type === 'cancel') {
      this.running?.abort();
    }
  }

  /** Emit one line into the persistent live session log (and the Output panel). */
  private sessionLog(text: string): void {
    this.output.appendLine(text);
    this.post({ type: 'stream', id: 'session', mode: 'log', text });
  }

  /** Read both providers' usage and log it in plain language. */
  private checkUsage(): UsageHeadroom {
    const floor = vscode.workspace.getConfiguration('orchestratorMvp').get<number>('usageFloorPercent', 20);
    this.sessionLog(`▸ Checking how much of your Claude and Codex usage is left…`);
    const usage = readUsage();
    this.sessionLog(`   ${humanUsage('Claude', usage.claude, floor)}`);
    this.sessionLog(`   ${humanUsage('Codex', usage.codex, floor)}`);
    return { ...usage, softFloor: floor };
  }

  /** Totals for the end-of-run summary. */
  private runSummary(results: SubtaskResult[]): { line: string; totalOut: number; byModel: { model: string; out: number }[] } {
    const totalOut = results.reduce((s, r) => s + r.outputTokens, 0);
    const totalIn = results.reduce((s, r) => s + r.inputTokens, 0);
    const byModelMap = new Map<string, number>();
    for (const r of results) {
      byModelMap.set(`${r.adapter}/${r.model}`, (byModelMap.get(`${r.adapter}/${r.model}`) ?? 0) + r.outputTokens);
    }
    const byModel = [...byModelMap.entries()].map(([model, out]) => ({ model, out }));
    const failed = results.filter((r) => !r.ok).length;
    const line = `${results.length} subtasks (${failed} failed) · ${totalIn} in / ${totalOut} out tokens · models: ${byModel.map((m) => `${m.model} (${m.out})`).join(', ')}`;
    return { line, totalOut, byModel };
  }

  // Steps 2–4: analyse → subtasks → routing → show plan for confirmation.
  private async analyze(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    const cfg = this.cfg();
    this.plan = undefined;
    this.output.clear();
    this.output.show(true);
    this.post({ type: 'status', text: `Analysing with ${cfg.mainModel} (${cfg.mainEffort})...` });
    try {
      const env = await spawnEnv();
      const usage = this.checkUsage();
      this.sessionLog(`▸ Analysing the request with ${modelLabel('claude', cfg.mainModel)} (${cfg.mainEffort} effort)…`);
      const main: MainModel = { bin: cfg.claudeBin, model: cfg.mainModel, effort: cfg.mainEffort, env, cwd: this.cwd(), timeoutMs: cfg.timeoutMs };
      const plan = await decompose(trimmed, main, usage, this.running?.signal, (event) => this.forwardLive('analysis', event));
      this.sessionLog(`▸ Plan ready: ${plan.subtasks.length} subtask(s). Review and press Run plan.`);
      this.plan = plan;
      this.post({ type: 'plan', plan, mainModel: cfg.mainModel, mainEffort: cfg.mainEffort });
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Forward a CLI event to the live log under a given stream id. */
  private forwardLive(id: string, event: { type: string; text?: string; inputTokens?: number; outputTokens?: number }): void {
    if (event.type === 'delta' && event.text) {
      this.output.append(event.text);
      this.post({ type: 'stream', id, mode: 'delta', text: event.text });
    } else if (event.type === 'log' && event.text) {
      this.output.appendLine(`[${id}] ${event.text}`);
      this.post({ type: 'stream', id, mode: 'log', text: event.text });
    } else if (event.type === 'usage') {
      const line = `tokens in=${event.inputTokens} out=${event.outputTokens}`;
      this.output.appendLine(`[${id}] ${line}`);
      this.post({ type: 'stream', id, mode: 'log', text: line });
    }
  }

  // Steps 5–7: run each subtask on its model, then combine with the main model.
  private async run(): Promise<void> {
    const plan = this.plan;
    if (!plan) {
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.post({ type: 'error', text: 'Open a folder in VS Code first — the orchestrator writes generated files into the current workspace folder.' });
      return;
    }
    const cfg = this.cfg();
    this.running = new AbortController();
    this.output.show(true);
    this.sessionLog(`\n▸ Running ${plan.subtasks.length} subtask(s) in ${this.cwd()}`);
    this.post({ type: 'runStart' });
    try {
      const env = await spawnEnv();
      const ctx: RunnerContext = {
        claudeBin: cfg.claudeBin,
        codexBin: cfg.codexBin,
        env,
        cwd: this.cwd(),
        timeoutMs: cfg.timeoutMs,
        signal: this.running.signal,
        onEvent: (e) => {
          if (e.type === 'start') {
            this.sessionLog(`\n▸ ${e.subtask.title} → ${modelLabel(e.subtask.adapter, e.subtask.model)} (${e.subtask.effort} effort)`);
            this.post({ type: 'progress', id: e.subtask.id, state: 'running', model: `${e.subtask.adapter}/${e.subtask.model}`, effort: e.subtask.effort });
          } else if (e.type === 'log' || e.type === 'delta' || e.type === 'usage') {
            this.forwardLive(e.subtask.id, e);
          } else {
            const tag = e.result.ok ? '✓' : '✗';
            this.sessionLog(`${tag} ${e.result.id} ${e.result.ok ? 'done' : 'failed'} · ${(e.result.durationMs / 1000).toFixed(0)}s · ${e.result.outputTokens.toLocaleString()} tokens · ${modelLabel(e.result.adapter, e.result.model)}`);
            // Reflect the model actually used (reroutes change it) in the plan row.
            this.post({ type: 'progress', id: e.result.id, state: e.result.ok ? 'done' : 'failed', model: `${e.result.adapter}/${e.result.model}`, effort: e.result.effort, error: e.result.error, seconds: (e.result.durationMs / 1000).toFixed(1), outTokens: e.result.outputTokens });
          }
        },
      };

      const results = await executePlan(plan, ctx);

      // Write each subtask's declared files as we go (workers emit ===FILE:=== blocks).
      const allArtifacts: { label: string; kind: string }[] = [];
      this.sessionLog(`\n▸ Writing files…`);
      for (const r of results) {
        if (!r.ok) {
          continue;
        }
        const files = parseFiles(r.text);
        const written = await writeFiles(this.cwd(), files, (line) => this.sessionLog(`   ${line}`));
        allArtifacts.push(...written.map((w) => ({ label: w.label, kind: 'generated' })));
      }

      this.post({ type: 'status', text: `Reviewing with ${modelLabel('claude', cfg.mainModel)}…` });
      this.sessionLog(`\n▸ Integration review with ${modelLabel('claude', cfg.mainModel)} (${cfg.mainEffort} effort)…`);
      const main: MainModel = { bin: cfg.claudeBin, model: cfg.mainModel, effort: cfg.mainEffort, env, cwd: this.cwd(), timeoutMs: cfg.timeoutMs };
      const report = await synthesize(plan, results, main, this.running.signal, (event) => this.forwardLive('review', event));

      // The review may emit corrected files; write those too.
      const fixes = parseFiles(report);
      if (fixes.length > 0) {
        this.sessionLog(`\n▸ Applying ${fixes.length} consistency fix(es)…`);
        const written = await writeFiles(this.cwd(), fixes, (line) => this.sessionLog(`   ${line}`));
        allArtifacts.push(...written.map((w) => ({ label: w.label, kind: 'fix' })));
      }

      const logRoot = await writeLogs(this.cwd(), plan, results, report);
      const summary = this.runSummary(results);
      this.sessionLog(`\n✓ Done. ${allArtifacts.length} file(s) written. ${summary.line}`);
      this.sessionLog(`  logs: ${logRoot}`);
      this.post({ type: 'result', report, subtasks: results, outputRoot: this.cwd(), logRoot, artifacts: allArtifacts, summary });
    } catch (e) {
      this.output.appendLine(`\n[error] ${e instanceof Error ? e.message : String(e)}`);
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = undefined;
    }
  }

  private html(): string {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${STYLE}</style></head>
<body>
  <h2>Orchestrator</h2>
  <p class="hint">Describe what you want built. Opus analyses it, splits it into subtasks, and assigns each to the most efficient model and effort.</p>
  <textarea id="prompt" rows="5" placeholder="e.g. Build a thread-safe in-memory job queue in Python with a CLI runner, concurrency tests, and a README."></textarea>
  <div class="row"><button id="analyze" class="primary">Analyse</button><span id="status" class="status"></span></div>
  <div id="plan"></div>
  <h3 id="livehdr" hidden>Live activity</h3>
  <div id="live"></div>
  <div id="results"></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`;
  }
}

function asEffort(value: unknown): Effort | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra' ? value : undefined;
}

/** Friendly model name from the catalog (e.g. "Claude Sonnet 5"), or the id. */
function modelLabel(adapter: string, model: string): string {
  const entry = findModel(adapter as 'claude' | 'codex', model);
  if (entry) {
    return entry.label;
  }
  // Resolved ids like claude-sonnet-5 → "Claude Sonnet 5".
  return model
    .replace(/-\d{6,}$/, '')
    .split(/[-/]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** One plain-language line about a provider's remaining usage. */
function humanUsage(name: string, u: { known: boolean; headroom?: number; reachedLimit?: boolean; resetsAt?: string }, floor: number): string {
  if (!u.known || u.headroom === undefined) {
    return `${name} — usage not reported by the CLI`;
  }
  const resets = u.resetsAt ? ` (resets ${untilText(u.resetsAt)})` : '';
  if (u.reachedLimit) {
    return `${name} — out of quota${resets}`;
  }
  if (u.headroom < floor) {
    return `${name} — running low, ${u.headroom}% left${resets} · work will shift to the other model`;
  }
  return `${name} — ${u.headroom}% left`;
}

/** "in 2h 10m" / "on Oct 1, 10 PM" style relative time. */
function untilText(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((then - Date.now()) / 60000);
  if (!Number.isFinite(mins)) {
    return new Date(iso).toLocaleString();
  }
  if (mins <= 0) {
    return 'shortly';
  }
  if (mins < 60) {
    return `in ${mins}m`;
  }
  if (mins < 24 * 60) {
    return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  return `on ${new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}`;
}

const STYLE = `
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; font-size: 13px; }
  h2 { margin: 0 0 4px; }
  .hint { color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #0000); border-radius: 4px; padding: 6px; font-family: inherit; resize: vertical; }
  .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  .status { color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border, #8884); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .diff { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .st-running { color: var(--vscode-charts-yellow, #cc0); }
  .st-done { color: var(--vscode-charts-green, #0a0); }
  .st-failed { color: var(--vscode-errorForeground, #f33); }
  .card { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; padding: 8px 10px; margin-top: 10px; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; }
  h3 { margin: 12px 0 4px; }
  .err { color: var(--vscode-errorForeground); }
  details { margin-top: 4px; }
  #activity { margin-top: 10px; }
  .actcard { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; margin-top: 8px; overflow: hidden; }
  .acthead { padding: 4px 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  .stream { margin: 0; max-height: 220px; overflow: auto; padding: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); }
  ul.files { margin: 6px 0 0; padding-left: 18px; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let plan = null;
const $ = (id) => document.getElementById(id);

$('analyze').addEventListener('click', () => {
  const prompt = $('prompt').value;
  if (!prompt.trim()) return;
  $('plan').innerHTML = ''; $('results').innerHTML = ''; $('live').innerHTML = '';
  $('livehdr').hidden = false;
  $('analyze').disabled = true;
  vscode.postMessage({ type: 'analyze', prompt });
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'status') { $('status').textContent = m.text; }
  else if (m.type === 'error') { $('status').textContent = ''; $('analyze').disabled = false; $('results').innerHTML = '<div class="card err">' + escapeHtml(m.text) + '</div>'; }
  else if (m.type === 'plan') { plan = m.plan; renderPlan(m.plan); $('analyze').disabled = false; $('status').textContent = ''; }
  else if (m.type === 'runStart') { const b = $('run'); if (b) { b.disabled = true; b.textContent = 'Running…'; } }
  else if (m.type === 'progress') { updateRow(m); }
  else if (m.type === 'stream') { streamTo(m); }
  else if (m.type === 'result') { renderResult(m); }
});

const LABELS = { session: 'orchestrator', analysis: 'analysis · main model', review: 'integration review · main model' };

// Live output per stream id (session, analysis, each subtask, final) — like a
// mini terminal, one card each, appended in order.
function streamTo(m) {
  const host = $('live');
  if (!host) return;
  let card = document.getElementById('act-' + m.id);
  if (!card) {
    card = document.createElement('div');
    card.className = 'actcard';
    card.id = 'act-' + m.id; // without this, every event made a new empty card
    card.innerHTML = '<div class="acthead mono">' + escapeHtml(LABELS[m.id] || m.id) + '</div><pre id="out-' + m.id + '" class="stream"></pre>';
    host.appendChild(card);
  }
  const pre = document.getElementById('out-' + m.id);
  if (!pre) return;
  if (m.mode === 'log') { pre.textContent += (pre.textContent ? '\\n' : '') + m.text; }
  else { pre.textContent += m.text; }
  pre.scrollTop = pre.scrollHeight;
}

function renderPlan(plan) {
  let rows = plan.subtasks.map(s => {
    const deps = s.dependsOn.length ? ' <span class="diff">after ' + s.dependsOn.join(', ') + '</span>' : '';
    return '<tr data-id="' + s.id + '">' +
      '<td class="mono">' + escapeHtml(s.id) + '</td>' +
      '<td>' + escapeHtml(s.title) + deps + '<div class="diff">' + escapeHtml(s.routingNote) + '</div></td>' +
      '<td>' + escapeHtml(s.kind) + '<br><span class="diff">' + escapeHtml(s.difficulty) + '</span></td>' +
      '<td id="model-' + s.id + '"><span class="pill">' + escapeHtml(s.adapter) + '</span><br><span class="mono diff">' + escapeHtml(s.model) + '</span><br><span class="diff">' + escapeHtml(s.effort) + '</span></td>' +
      '<td class="status st" id="st-' + s.id + '">—</td>' +
      '</tr>';
  }).join('');
  $('plan').innerHTML =
    '<table><thead><tr><th>id</th><th>subtask</th><th>kind</th><th>model</th><th>status</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="row"><button id="run" class="primary">Run plan</button><button id="cancel">Cancel</button>' +
    '<span class="diff">' + plan.subtasks.length + ' subtasks - analysed by main model</span></div>';
  $('run').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
}

function updateRow(m) {
  const cell = $('st-' + m.id);
  if (!cell) return;
  if (m.state === 'running') { cell.className = 'status st-running'; cell.textContent = 'running…'; }
  else if (m.state === 'done') { cell.className = 'status st-done'; cell.textContent = 'done ' + m.seconds + 's / ' + m.outTokens + ' out'; }
  else { cell.className = 'status st-failed'; cell.textContent = 'failed: ' + (m.error || 'failed'); }
  // Reflect the model actually used (may differ from the plan after a reroute).
  const mc = $('model-' + m.id);
  if (mc && m.model) {
    const [adapter, model] = m.model.split('/');
    mc.innerHTML = '<span class="pill">' + escapeHtml(adapter) + '</span><br><span class="mono diff">' + escapeHtml(model || '') + '</span><br><span class="diff">' + escapeHtml(m.effort || '') + '</span>';
  }
}

function renderResult(m) {
  let html = '';
  if (m.summary) {
    html += '<h3>Summary</h3><div class="card diff">' + escapeHtml(m.summary.line) + '</div>';
  }
  const files = (m.artifacts || []);
  const fileList = files.map(a => '<li class="mono">' + escapeHtml(a.label) + (a.kind === 'fix' ? ' <span class="diff">(fixed in review)</span>' : '') + '</li>').join('');
  html += '<h3>Files written to your workspace</h3><div class="card"><div class="mono diff">' + escapeHtml(m.outputRoot || '') + '</div><ul class="files">' + (fileList || '<li class="diff">no files were declared by the workers</li>') + '</ul>' +
    (m.logRoot ? '<div class="diff">logs &amp; raw transcripts: ' + escapeHtml(m.logRoot) + '</div>' : '') + '</div>';
  html += '<h3>Integration review</h3><div class="card"><pre>' + escapeHtml(m.report || '') + '</pre></div>';
  html += '<h3>Per-subtask transcripts</h3>';
  for (const r of m.subtasks) {
    html += '<details><summary>' + escapeHtml(r.id) + ' — ' + escapeHtml(r.adapter + '/' + r.model + ' / ' + r.effort) + (r.ok ? '' : ' (failed)') + '</summary>' +
      '<div class="card">' + (r.ok ? '<pre>' + escapeHtml(r.text) + '</pre>' : '<div class="err">' + escapeHtml(r.error || 'failed') + '</div>') + '</div></details>';
  }
  $('results').innerHTML = html;
  const b = $('run'); if (b) { b.disabled = false; b.textContent = 'Run again'; }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
`;
