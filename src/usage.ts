import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from './types.ts';

/**
 * Reads how much subscription usage is left for Claude and Codex, from the data
 * the CLIs already cache locally. No network — the same numbers `/usage`
 * (Claude) and `/status` (Codex) show.
 *
 *   Claude: ~/.claude.json → cachedUsageUtilization.utilization
 *   Codex:  newest ~/.codex/sessions/**\/rollout-*.jsonl → last "rate_limits"
 *
 * Best-effort: any failure yields `known:false`, which routing treats as
 * "assume available" — a missing reading never blocks a provider.
 */

export interface ProviderUsage {
  adapter: Adapter;
  known: boolean;
  usedPercent?: number;
  headroom?: number;
  resetsAt?: string;
  reachedLimit?: boolean;
  detail: string;
}

export function readClaudeUsage(home = homedir()): ProviderUsage {
  try {
    const raw = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      cachedUsageUtilization?: { utilization?: Record<string, { utilization?: number; resets_at?: string | null }> };
    };
    const util = raw.cachedUsageUtilization?.utilization;
    const windows = [util?.five_hour, util?.seven_day].filter(Boolean) as { utilization?: number; resets_at?: string | null }[];
    const pcts = windows.map((w) => w.utilization).filter((n): n is number => typeof n === 'number');
    if (pcts.length === 0) {
      return { adapter: 'claude', known: false, detail: 'no utilization cache' };
    }
    const usedPercent = Math.max(...pcts);
    const headroom = round(100 - usedPercent);
    const resets = windows.map((w) => w.resets_at).filter((r): r is string => typeof r === 'string').sort()[0];
    return {
      adapter: 'claude',
      known: true,
      usedPercent,
      headroom,
      ...(resets ? { resetsAt: resets } : {}),
      reachedLimit: usedPercent >= 100,
      detail: `5h/weekly worst ${usedPercent}% used → ${headroom}% headroom`,
    };
  } catch {
    return { adapter: 'claude', known: false, detail: 'usage cache unreadable' };
  }
}

export function readCodexUsage(home = homedir()): ProviderUsage {
  try {
    const rollout = newestRollout(join(home, '.codex', 'sessions'));
    if (!rollout) {
      return { adapter: 'codex', known: false, detail: 'no rollout sessions' };
    }
    const snap = lastRateLimits(readFileSync(rollout, 'utf8'));
    if (!snap) {
      return { adapter: 'codex', known: false, detail: 'no rate_limits in rollout' };
    }
    const windows = [snap.primary, snap.secondary].filter(Boolean) as { used_percent?: number; resets_at?: number }[];
    const pcts = windows.map((w) => w.used_percent).filter((n): n is number => typeof n === 'number');
    if (pcts.length === 0) {
      return { adapter: 'codex', known: false, detail: 'rate_limits had no percentages' };
    }
    const usedPercent = Math.max(...pcts);
    const headroom = round(100 - usedPercent);
    const resetsEpoch = windows.map((w) => w.resets_at).filter((r): r is number => typeof r === 'number').sort((a, b) => a - b)[0];
    return {
      adapter: 'codex',
      known: true,
      usedPercent,
      headroom,
      ...(resetsEpoch ? { resetsAt: new Date(resetsEpoch * 1000).toISOString() } : {}),
      reachedLimit: Boolean(snap.rate_limit_reached_type) || usedPercent >= 100,
      detail: `worst window ${usedPercent}% used → ${headroom}% headroom`,
    };
  } catch {
    return { adapter: 'codex', known: false, detail: 'usage cache unreadable' };
  }
}

export function readUsage(home = homedir()): { claude: ProviderUsage; codex: ProviderUsage } {
  return { claude: readClaudeUsage(home), codex: readCodexUsage(home) };
}

interface CodexRateLimits {
  primary?: { used_percent?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; resets_at?: number } | null;
  rate_limit_reached_type?: string | null;
}

export function lastRateLimits(content: string): CodexRateLimits | undefined {
  let found: CodexRateLimits | undefined;
  for (const line of content.split('\n')) {
    if (!line.includes('"rate_limits"')) {
      continue;
    }
    try {
      const rl = find(JSON.parse(line));
      if (rl) {
        found = rl;
      }
    } catch {
      /* skip */
    }
  }
  return found;
  function find(node: unknown): CodexRateLimits | undefined {
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (rec.rate_limits && typeof rec.rate_limits === 'object') {
        return rec.rate_limits as CodexRateLimits;
      }
      for (const v of Object.values(rec)) {
        const hit = find(v);
        if (hit) {
          return hit;
        }
      }
    }
    return undefined;
  }
}

function newestRollout(root: string): string | undefined {
  let best: { path: string; mtime: number } | undefined;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) {
          best = { path: full, mtime };
        }
      }
    }
  };
  walk(root);
  return best?.path;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
