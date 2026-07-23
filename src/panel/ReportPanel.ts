import * as vscode from 'vscode';
import type { ExecutionPlan, RunAccounting, SavingsReport } from '../types/ir.ts';
import { describeUsage } from '../accounting/baseline.ts';
import { totalTokens } from '../accounting/meter.ts';
import { formatTokens, formatUsd } from '../optimize/tokens.ts';
import { esc, html, nonce } from './webview.ts';

/**
 * The savings report.
 *
 * Built to survive an audit rather than to look impressive. Three rules it
 * follows, all of which cost headline numbers:
 *
 *   - Gauss planning cost is inside the actual total, never netted out.
 *   - The baseline is labelled an estimate, with its multiplier and sample size
 *     shown, until real A/B runs have calibrated it.
 *   - A negative saving is displayed as a negative saving.
 *
 * A number nobody can check is worth less than a smaller number they can.
 */

export function showReportPanel(
  report: SavingsReport,
  plan: ExecutionPlan,
  accounting: RunAccounting,
  contextTokensSaved: number,
): void {
  const panel = vscode.window.createWebviewPanel(
    'orchestrator.report',
    'Orchestrator — savings report',
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = html('Savings report', renderBody(report, plan, accounting, contextTokensSaved), '', nonce());
}

function renderBody(
  report: SavingsReport,
  plan: ExecutionPlan,
  accounting: RunAccounting,
  contextTokensSaved: number,
): string {
  const planningUsd = accounting.planning.reduce((sum, record) => sum + record.usd, 0);
  const executionUsd = accounting.execution.reduce((sum, record) => sum + record.usd, 0);
  const uncalibrated = report.baseline.calibrationSamples === 0;
  const derived = accounting.execution.filter((record) => !record.usdReported);

  const rows = [...accounting.planning, ...accounting.execution]
    .map(
      (record) => `<tr>
        <td><span class="tier ${record.adapter === 'gauss' ? 'tier-restricted' : 'tier-internal'}">${esc(record.adapter)}</span></td>
        <td class="mono">${esc(record.model)}</td>
        <td class="muted">${esc(formatTokens(record.usage.inputTokens))}</td>
        <td class="muted">${esc(formatTokens(record.usage.outputTokens))}</td>
        <td class="muted">${esc(formatTokens(record.usage.cachedInputTokens))}</td>
        <td>${esc(formatUsd(record.usd))}</td>
        <td class="muted">${record.usdReported ? 'reported' : 'derived'}</td>
      </tr>`,
    )
    .join('');

  const cached = report.actualUsage.cachedInputTokens;
  const cacheShare =
    report.actualUsage.inputTokens + cached > 0
      ? Math.round((cached / (report.actualUsage.inputTokens + cached)) * 100)
      : 0;

  return `
    <h1>Savings report</h1>
    <p class="sub">Plan <span class="mono">${esc(plan.id)}</span> — ${plan.subtasks.length} subtask${plan.subtasks.length === 1 ? '' : 's'}</p>

    <div class="stat">
      <div><div class="k">actual spend</div><div class="v">${esc(formatUsd(report.actualUsd))}</div></div>
      <div><div class="k">modelled baseline</div><div class="v">${esc(formatUsd(report.baseline.usd))}</div></div>
      <div><div class="k">net saving</div>
        <div class="v ${report.netUsd >= 0 ? 'pos' : 'neg'}">${esc(formatUsd(report.netUsd))}</div></div>
      <div><div class="k">of baseline</div>
        <div class="v ${report.netFraction >= 0 ? 'pos' : 'neg'}">${Math.round(report.netFraction * 100)}%</div></div>
    </div>

    ${
      report.netUsd < 0
        ? `<div class="warn"><strong>This run cost more than the baseline.</strong>
             Orchestration overhead exceeded the saving — usually because the task was small enough that
             planning dominated. Lower <code>orchestrator.scan.batchSize</code> or let the fast path handle
             small requests.</div>`
        : ''
    }

    ${
      uncalibrated
        ? `<div class="warn"><strong>The baseline is uncalibrated.</strong>
             With no measured A/B runs yet, the exploration multiplier is 1.0 — meaning we assume a naive run
             would have read exactly the files we selected and no more. That is certainly too generous to the
             baseline, so this figure <em>understates</em> the real saving. Run
             <code>Orchestrator: Calibrate Savings Baseline</code> a few times to fit it against reality.</div>`
        : `<p class="muted">Baseline uses an exploration multiplier of
             ${report.baseline.explorationMultiplier.toFixed(2)} fitted from
             ${report.baseline.calibrationSamples} measured run${report.baseline.calibrationSamples === 1 ? '' : 's'}${
               report.baseline.calibratedAt ? `, last updated ${esc(report.baseline.calibratedAt.slice(0, 10))}` : ''
             }.</p>`
    }

    <h2>How the two numbers were produced</h2>
    <table>
      <tbody>
        <tr><td><strong>Actual</strong></td><td>
          Exact. Summed from provider-reported usage across every call, <strong>including
          ${esc(formatUsd(planningUsd))} of Gauss planning</strong>. Execution was ${esc(formatUsd(executionUsd))}.
        </td></tr>
        <tr><td><strong>Baseline</strong></td><td>
          ${report.baseline.source === 'measured' ? 'Measured by actually running the naive path.' : 'Modelled, not measured.'}
          Assumes one ${esc(report.baseline.model)} run over the raw prompt plus the full contents of every file
          this plan touched: ${esc(describeUsage(report.baseline.usage))}.
          Excludes retries and wasted runs, both of which would favour us.
        </td></tr>
      </tbody>
    </table>

    <h2>Where the tokens went</h2>
    <div class="stat">
      <div><div class="k">total tokens</div><div class="v">${esc(formatTokens(totalTokens(report.actualUsage)))}</div></div>
      <div><div class="k">context avoided</div><div class="v">${esc(formatTokens(contextTokensSaved))}</div></div>
      <div><div class="k">cache hit</div><div class="v">${cacheShare}%</div></div>
      <div><div class="k">output tokens</div><div class="v">${esc(formatTokens(report.actualUsage.outputTokens))}</div></div>
    </div>
    <p class="muted">
      "Context avoided" is what skeletonizing, slicing and compressing saved versus sending every selected
      file whole. "Cache hit" is the share of input tokens served from the provider prompt cache — if this
      stays near zero across sequential subtasks, prefix stability has broken and is worth investigating.
    </p>

    <h2>Every call</h2>
    <table>
      <thead><tr><th>adapter</th><th>model</th><th>in</th><th>out</th><th>cached</th><th>cost</th><th>source</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${
      derived.length > 0
        ? `<p class="muted">${derived.length} call${derived.length === 1 ? '' : 's'} had no provider-reported cost,
             so the figure came from the local price table. Check <code>orchestrator.pricing</code> is current.</p>`
        : ''
    }`;
}
