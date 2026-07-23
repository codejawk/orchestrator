import type { FileVerdict, ScanReport } from '../planner/scanner.ts';
import type { ApprovalStore } from '../policy/approvals.ts';
import { TIER_RANK, type Tier } from '../types/ir.ts';
import { formatTokens } from '../optimize/tokens.ts';
import { DecisionPanel, esc, html, nonce } from './webview.ts';

/**
 * The approval gate.
 *
 * This panel is the moment the whole design turns on: a person looks at what
 * the scan found and decides what may leave the network. Three deliberate
 * choices in the UI:
 *
 *   - Nothing is pre-approved. Every checkbox starts unticked, so walking away
 *     approves nothing.
 *   - Restricted files are not selectable unless the override setting is on.
 *     A tired reviewer bulk-ticking a list must not be able to send bootloader
 *     source to a public provider.
 *   - The riskiest files sort to the top, because that is where attention is
 *     scarcest.
 */

export interface ReviewDecision {
  externalAllowed: string[];
  gaussOnly: string[];
}

const TIER_ORDER: Tier[] = ['restricted', 'confidential', 'internal', 'public'];

const TIER_BLURB: Record<Tier, string> = {
  restricted: 'Never leaves the company. Bootloader, TEE, Knox, key material, credentials.',
  confidential: 'Unreleased product detail, roadmap, partner specifics, internal architecture.',
  internal: 'Ordinary company code. Safe externally under an enterprise agreement.',
  public: 'Open source, boilerplate, public documentation.',
};

export async function showReviewPanel(
  report: ScanReport,
  approvals: ApprovalStore,
  allowRestrictedOverride: boolean,
): Promise<ReviewDecision | undefined> {
  const panel = new DecisionPanel<ReviewDecision>('orchestrator.review', 'Orchestrator — file review');
  const cspNonce = nonce();

  const sorted = [...report.files].sort((a, b) => {
    const byTier = TIER_RANK[b.tier] - TIER_RANK[a.tier];
    return byTier !== 0 ? byTier : a.path.localeCompare(b.path);
  });

  panel.setHtml(html('File review', renderBody(report, sorted, approvals, allowRestrictedOverride), SCRIPT, cspNonce));

  panel.onMessage((message: { type: string; externalAllowed?: string[]; gaussOnly?: string[] }) => {
    if (message.type === 'approve') {
      panel.settle({
        externalAllowed: message.externalAllowed ?? [],
        gaussOnly: message.gaussOnly ?? [],
      });
    } else if (message.type === 'cancel') {
      panel.settle(undefined);
    }
  });

  return panel.wait();
}

function renderBody(
  report: ScanReport,
  files: FileVerdict[],
  approvals: ApprovalStore,
  allowRestrictedOverride: boolean,
): string {
  const counts = TIER_ORDER.map((tier) => ({
    tier,
    n: files.filter((file) => file.tier === tier).length,
  })).filter((entry) => entry.n > 0);

  const scanCost = report.costs.reduce((sum, record) => sum + record.usd, 0);

  const groups = TIER_ORDER.map((tier) => {
    const inTier = files.filter((file) => file.tier === tier);
    if (inTier.length === 0) {
      return '';
    }
    const locked = tier === 'restricted' && !allowRestrictedOverride;

    return `
      <h2><span class="tier tier-${tier}">${esc(tier)}</span> &nbsp;${inTier.length} file${inTier.length === 1 ? '' : 's'}</h2>
      <p class="sub">${esc(TIER_BLURB[tier])}${
        locked
          ? ' <strong>These cannot be approved for external use.</strong> Enable <code>orchestrator.policy.allowRestrictedOverride</code> to make it a per-file decision.'
          : ''
      }</p>
      <table>
        <thead><tr>
          <th style="width:28px">${locked ? '' : `<input type="checkbox" data-group="${esc(tier)}" class="group-toggle">`}</th>
          <th>File</th><th style="width:80px">Tokens</th><th>Why</th><th style="width:150px">Status</th>
        </tr></thead>
        <tbody>
        ${inTier.map((file) => renderRow(file, approvals, locked)).join('\n')}
        </tbody>
      </table>`;
  }).join('\n');

  return `
    <h1>Review before anything leaves the network</h1>
    <p class="sub">
      Gauss classified ${files.length} file${files.length === 1 ? '' : 's'}
      ${report.skipped.length > 0 ? `(${report.skipped.length} skipped as binary or oversized)` : ''}.
      Tick a file to allow it in prompts sent to Claude, Codex or Gemini.
      <strong>Anything left unticked stays on Gauss.</strong>
    </p>

    <div class="stat">
      ${counts.map((entry) => `<div><div class="k">${esc(entry.tier)}</div><div class="v">${entry.n}</div></div>`).join('')}
      <div><div class="k">scan cost</div><div class="v">$${scanCost.toFixed(4)}</div></div>
    </div>

    ${
      report.warnings.length > 0
        ? `<div class="warn"><strong>Scan warnings</strong><ul>${report.warnings
            .slice(0, 12)
            .map((warning) => `<li>${esc(warning)}</li>`)
            .join('')}</ul>${
            report.warnings.length > 12 ? `<p class="muted">…and ${report.warnings.length - 12} more.</p>` : ''
          }</div>`
        : ''
    }

    <div class="warn">
      Gauss sees a sample of each file, not always all of it. Pattern-based secret detection runs on
      complete content, so keys and credentials are caught regardless — but a lone sensitive paragraph
      buried in a long file can be missed. Raise <code>orchestrator.scan.digestTokens</code> if that
      matters more to you than scan cost.
    </div>

    ${groups}

    <div class="actions">
      <button class="primary" id="approve">Approve selection</button>
      <button id="none">Everything stays on Gauss</button>
      <span class="spacer"></span>
      <span class="muted" id="summary">0 selected for external use</span>
      <button id="cancel">Cancel</button>
    </div>`;
}

function renderRow(file: FileVerdict, approvals: ApprovalStore, locked: boolean): string {
  const routing = approvals.route(file);
  const stale = approvals.isStale(file.path, file.contentHash);
  const checked = routing.externalAllowed ? 'checked' : '';

  const status = stale
    ? '<span class="muted">changed since approval</span>'
    : routing.externalAllowed
      ? '<span class="pos">approved</span>'
      : `<span class="muted">Gauss only</span>`;

  return `<tr>
    <td>${
      locked
        ? '<span class="muted" title="restricted files cannot be approved">—</span>'
        : `<input type="checkbox" class="file" data-path="${esc(file.path)}" data-group="${esc(file.tier)}" ${checked}>`
    }</td>
    <td class="mono">${esc(file.path)}</td>
    <td class="muted">${esc(formatTokens(file.estTokens))}</td>
    <td>${esc(file.summary ?? file.reasons[0]?.detail ?? '—')}
      ${
        file.reasons.length > 1
          ? `<details><summary>${file.reasons.length} signals</summary><ul>${file.reasons
              .map((reason) => `<li>${esc(reason.signal)}: ${esc(reason.detail)}</li>`)
              .join('')}</ul></details>`
          : ''
      }
    </td>
    <td>${status}</td>
  </tr>`;
}

const SCRIPT = `
const vscode = acquireVsCodeApi();
const boxes = () => Array.from(document.querySelectorAll('input.file'));

function refresh() {
  const n = boxes().filter(b => b.checked).length;
  document.getElementById('summary').textContent =
    n + ' selected for external use, ' + (boxes().length - n) + ' staying on Gauss';
}

document.querySelectorAll('.group-toggle').forEach(toggle => {
  toggle.addEventListener('change', () => {
    boxes()
      .filter(b => b.dataset.group === toggle.dataset.group)
      .forEach(b => { b.checked = toggle.checked; });
    refresh();
  });
});

document.addEventListener('change', e => {
  if (e.target.classList && e.target.classList.contains('file')) refresh();
});

function send() {
  const all = boxes();
  vscode.postMessage({
    type: 'approve',
    externalAllowed: all.filter(b => b.checked).map(b => b.dataset.path),
    gaussOnly: all.filter(b => !b.checked).map(b => b.dataset.path),
  });
}

document.getElementById('approve').addEventListener('click', send);
document.getElementById('none').addEventListener('click', () => {
  boxes().forEach(b => { b.checked = false; });
  refresh();
  send();
});
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
refresh();
`;
