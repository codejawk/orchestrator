import * as vscode from 'vscode';
import type { Tier } from '../types/ir.ts';
import { TIER_RANK } from '../types/ir.ts';
import { formatTokens } from '../optimize/tokens.ts';
import { esc, html, nonce } from './webview.ts';

/**
 * The step-0 precheck map.
 *
 * Answers one question at a glance before any request: which of my files are
 * safe to share, and which must never leave? It runs the free regex sweep over
 * the whole tree — instant, no model, no cost — and paints each file
 * red / amber / green. Red is where attention belongs, so red sorts to the top.
 *
 * This is a read-only view. It changes nothing and sends nothing; it is the
 * "look before you leap" the user asked for as step 0.
 */

export interface PrecheckEntry {
  path: string;
  tier: Tier;
  reasons: { signal: string; detail: string }[];
  estTokens: number;
}

const TIER_META: Record<Tier, { label: string; blurb: string }> = {
  restricted: { label: 'restricted', blurb: 'Never leaves the company. Excluded from external models entirely.' },
  confidential: { label: 'confidential', blurb: 'Held back by default; can be sent only with explicit approval.' },
  internal: { label: 'internal', blurb: 'Ordinary company code. Shareable externally once you approve it.' },
  public: { label: 'public', blurb: 'Open-source or generic. Safe to share.' },
};

const ORDER: Tier[] = ['restricted', 'confidential', 'internal', 'public'];

export function showSecurityMap(entries: PrecheckEntry[], scannedCount: number): void {
  const panel = vscode.window.createWebviewPanel(
    'orchestrator.securityMap',
    'Orchestrator — workspace security map',
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = html('Security map', renderBody(entries, scannedCount), '', nonce());
}

function renderBody(entries: PrecheckEntry[], scannedCount: number): string {
  const counts = ORDER.map((tier) => ({ tier, n: entries.filter((e) => e.tier === tier).length }));
  const flagged = entries.filter((e) => TIER_RANK[e.tier] >= TIER_RANK.confidential);

  const sorted = [...entries].sort((a, b) => {
    const byTier = TIER_RANK[b.tier] - TIER_RANK[a.tier];
    return byTier !== 0 ? byTier : a.path.localeCompare(b.path);
  });

  const groups = ORDER.map((tier) => {
    const inTier = sorted.filter((e) => e.tier === tier);
    if (inTier.length === 0) {
      return '';
    }
    return `
      <h2><span class="tier tier-${tier}">${esc(TIER_META[tier].label)}</span> &nbsp;${inTier.length}</h2>
      <p class="sub">${esc(TIER_META[tier].blurb)}</p>
      <table>
        <thead><tr><th>File</th><th style="width:80px">Tokens</th><th>Why flagged</th></tr></thead>
        <tbody>
        ${inTier
          .map(
            (e) => `<tr>
              <td class="mono">${esc(e.path)}</td>
              <td class="muted">${esc(formatTokens(e.estTokens))}</td>
              <td>${e.reasons.length > 0 ? esc(e.reasons[0]?.detail ?? '') : '<span class="muted">—</span>'}</td>
            </tr>`,
          )
          .join('')}
        </tbody>
      </table>`;
  }).join('');

  return `
    <h1>Workspace security map</h1>
    <p class="sub">
      Swept <strong>${scannedCount} files</strong> with deterministic rules — no model, no cost.
      This is a precheck: nothing has been sent anywhere.
    </p>

    <div class="stat">
      ${counts
        .map((c) => `<div><div class="k">${esc(c.tier)}</div><div class="v ${c.tier === 'restricted' || c.tier === 'confidential' ? 'neg' : 'pos'}">${c.n}</div></div>`)
        .join('')}
    </div>

    ${
      flagged.length > 0
        ? `<div class="danger"><strong>${flagged.length} file${flagged.length === 1 ? '' : 's'} flagged as sensitive.</strong>
             These are held back from external models. Restricted files can never be sent; confidential files need explicit per-file approval when a request touches them.</div>`
        : `<div class="warn">No files matched a sensitive pattern. Note the sweep is pattern-based — the deeper model classification still runs on files a request actually touches.</div>`
    }

    ${groups}

    <p class="muted" style="margin-top:20px">
      This map uses fast regex rules (secrets, bootloader, TEE/Knox, confidentiality markings, codenames).
      When you make a request, the files it selects also get a semantic classification from the planner model.
    </p>`;
}
