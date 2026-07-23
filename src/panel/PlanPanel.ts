import type { ExecutionPlan } from '../types/ir.ts';
import { formatTokens, formatUsd } from '../optimize/tokens.ts';
import { topologicalWaves } from '../planner/decompose.ts';
import { DecisionPanel, esc, html, nonce } from './webview.ts';

/**
 * The execution plan, for approval.
 *
 * Shows which model gets which subtask and — the part that matters — why.
 * Subtasks pinned to Gauss by policy are called out explicitly rather than
 * quietly assigned, because a reviewer needs to see that the control fired.
 *
 * Costs are labelled as forecasts throughout. The report afterwards uses real
 * provider-reported numbers, and blurring the two would train people to
 * distrust both.
 */

export interface PlanDecision {
  approved: boolean;
  /** Subtask ids the user deselected. */
  excluded: string[];
}

export async function showPlanPanel(
  plan: ExecutionPlan,
  warnings: string[],
  compression: { before: number; after: number },
): Promise<PlanDecision | undefined> {
  const panel = new DecisionPanel<PlanDecision>('orchestrator.plan', 'Orchestrator — execution plan');
  panel.setHtml(html('Execution plan', renderBody(plan, warnings, compression), SCRIPT, nonce()));

  panel.onMessage((message: { type: string; excluded?: string[] }) => {
    if (message.type === 'approve') {
      panel.settle({ approved: true, excluded: message.excluded ?? [] });
    } else if (message.type === 'reject') {
      panel.settle(undefined);
    }
  });

  return panel.wait();
}

function renderBody(
  plan: ExecutionPlan,
  warnings: string[],
  compression: { before: number; after: number },
): string {
  const waves = topologicalWaves(plan.subtasks);
  const byId = new Map(plan.subtasks.map((subtask) => [subtask.id, subtask]));
  const pinned = plan.subtasks.filter((subtask) => subtask.routingNote?.startsWith('Pinned to Gauss'));
  const externalCount = plan.subtasks.filter((subtask) => subtask.adapter !== 'gauss').length;

  const ratio =
    compression.before > 0 ? Math.round((1 - compression.after / compression.before) * 100) : 0;

  const rows = waves
    .map(
      (wave, index) => `
      <tr><td colspan="7" class="muted" style="padding-top:14px">
        Wave ${index + 1}${wave.length > 1 ? ` — ${wave.length} subtasks run in parallel` : ''}
      </td></tr>
      ${wave
        .map((id) => byId.get(id))
        .filter((subtask): subtask is NonNullable<typeof subtask> => Boolean(subtask))
        .map(
          (subtask) => `
        <tr>
          <td><input type="checkbox" class="task" data-id="${esc(subtask.id)}" checked></td>
          <td class="mono">${esc(subtask.id)}</td>
          <td>${esc(subtask.kind)}</td>
          <td>${esc(subtask.goal)}
            ${
              subtask.context.length > 0
                ? `<details><summary>${subtask.context.length} file${subtask.context.length === 1 ? '' : 's'}</summary>
                     <ul>${subtask.context
                       .map((ref) => `<li class="mono">${esc(ref.path)} <span class="muted">(${esc(ref.mode)})</span></li>`)
                       .join('')}</ul></details>`
                : ''
            }
            ${subtask.routingNote ? `<div class="muted">${esc(subtask.routingNote)}</div>` : ''}
          </td>
          <td><span class="tier ${subtask.adapter === 'gauss' ? 'tier-restricted' : 'tier-internal'}">${esc(subtask.adapter)}</span><br><span class="muted mono">${esc(subtask.model)}</span></td>
          <td class="muted">${esc(formatTokens(subtask.estimate.inTokens))} in<br>${esc(formatTokens(subtask.estimate.outTokens))} out</td>
          <td>${esc(formatUsd(subtask.estimate.usd))}</td>
        </tr>`,
        )
        .join('')}`,
    )
    .join('');

  return `
    <h1>Execution plan</h1>
    <p class="sub">
      Planning ran entirely on Gauss and cost ${esc(formatUsd(plan.planningCost.usd))}.
      Nothing has been sent to an external model yet.
    </p>

    <div class="stat">
      <div><div class="k">subtasks</div><div class="v">${plan.subtasks.length}</div></div>
      <div><div class="k">to external models</div><div class="v">${externalCount}</div></div>
      <div><div class="k">pinned to Gauss</div><div class="v">${pinned.length}</div></div>
      <div><div class="k">forecast cost</div><div class="v">${esc(formatUsd(plan.estimate.usd))}</div></div>
      <div><div class="k">prompt compressed</div><div class="v">${ratio}%</div></div>
    </div>

    ${
      pinned.length > 0
        ? `<div class="danger"><strong>${pinned.length} subtask${pinned.length === 1 ? '' : 's'} pinned to Gauss by policy.</strong>
             <ul>${pinned.map((subtask) => `<li class="mono">${esc(subtask.id)}<span class="muted"> — ${esc(subtask.routingNote ?? '')}</span></li>`).join('')}</ul>
             These cannot be moved to an external model from this screen. Change the file approvals if that is wrong.</div>`
        : ''
    }

    ${
      warnings.length > 0
        ? `<div class="warn"><strong>Planning warnings</strong><ul>${warnings
            .map((warning) => `<li>${esc(warning)}</li>`)
            .join('')}</ul></div>`
        : ''
    }

    <h2>Goal</h2>
    <p>${esc(plan.ir.goal)}</p>
    ${list('Constraints', plan.ir.constraints)}
    ${list('Done when', plan.ir.acceptance)}
    ${list('Will not do', plan.ir.nonGoals)}

    <h2>Subtasks</h2>
    <table>
      <thead><tr>
        <th style="width:28px"></th><th style="width:90px">id</th><th style="width:80px">kind</th>
        <th>goal</th><th style="width:120px">model</th><th style="width:90px">tokens</th><th style="width:70px">est.</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted" style="margin-top:10px">
      Token and cost figures are forecasts. The report after the run uses provider-reported numbers.
    </p>

    <div class="actions">
      <button class="primary" id="approve">Run plan</button>
      <button id="reject">Cancel</button>
      <span class="spacer"></span>
      <span class="muted" id="summary"></span>
    </div>`;
}

function list(title: string, items: string[]): string {
  if (items.length === 0) {
    return '';
  }
  return `<h2>${esc(title)}</h2><ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
}

const SCRIPT = `
const vscode = acquireVsCodeApi();
const tasks = () => Array.from(document.querySelectorAll('input.task'));

function refresh() {
  const n = tasks().filter(t => t.checked).length;
  document.getElementById('summary').textContent = n + ' of ' + tasks().length + ' subtasks selected';
  document.getElementById('approve').disabled = n === 0;
}

document.addEventListener('change', e => {
  if (e.target.classList && e.target.classList.contains('task')) refresh();
});

document.getElementById('approve').addEventListener('click', () => {
  vscode.postMessage({
    type: 'approve',
    excluded: tasks().filter(t => !t.checked).map(t => t.dataset.id),
  });
});
document.getElementById('reject').addEventListener('click', () => vscode.postMessage({ type: 'reject' }));
refresh();
`;
