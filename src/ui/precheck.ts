import * as vscode from 'vscode';
import { gaussConfig } from '../config.ts';
import type { Pipeline } from '../pipeline.ts';
import { showSecurityMap } from '../panel/SecurityMapPanel.ts';

/**
 * The two-phase precheck, shared by the command and the chat participant.
 *
 *   Phase 1 — regex. Instant, free, deterministic. Shown immediately so the
 *             user sees something before any model runs.
 *   Phase 2 — the planner model classifies what regex could not decide. Only
 *             runs when a planner is configured. Replaces the phase-1 map with
 *             the richer one.
 *
 * Splitting it this way gives fast feedback and honest cost: you always get the
 * free answer, and the paid one only when you have a planner and are willing to
 * wait for it.
 */
export interface PrecheckSummary {
  scannedCount: number;
  regexFlagged: number;
  modelFlagged?: number;
  skipped: number;
  costUsd?: number;
  ranPhase2: boolean;
}

export async function runTwoPhasePrecheck(
  pipeline: Pipeline,
  progress: (message: string) => void,
  token?: vscode.CancellationToken,
): Promise<PrecheckSummary> {
  // Phase 1 — regex.
  progress('Phase 1 — regex sweep…');
  const p1 = await pipeline.precheck(undefined, token);
  const regexFlagged = p1.entries.filter((e) => e.tier === 'restricted' || e.tier === 'confidential').length;

  const panel = showSecurityMap(p1.entries, p1.scannedCount, p1.skipped, {
    phase: 'Phase 1 — regex (instant, free)',
  });

  if (!gaussConfig().baseUrl) {
    // No planner: phase 1 is all we can do. Leave its map up.
    return { scannedCount: p1.scannedCount, regexFlagged, skipped: p1.skipped.length, ranPhase2: false };
  }

  // Phase 2 — model.
  progress('Phase 2 — model classification…');
  try {
    const p2 = await pipeline.precheckDeep(undefined, progress, token);
    const modelFlagged = p2.entries.filter((e) => e.tier === 'restricted' || e.tier === 'confidential').length;

    // Replace the phase-1 map with the richer phase-2 one.
    panel.dispose();
    showSecurityMap(p2.entries, p2.scannedCount, p2.skipped, {
      phase: 'Phase 2 — regex + model classification',
      costUsd: p2.costUsd,
    });

    return {
      scannedCount: p2.scannedCount,
      regexFlagged,
      modelFlagged,
      skipped: p2.skipped.length,
      costUsd: p2.costUsd,
      ranPhase2: true,
    };
  } catch (error) {
    // Phase 2 failed (planner unreachable, cancelled): keep the phase-1 map and
    // report it rather than losing the free result too.
    progress(`Phase 2 failed: ${error instanceof Error ? error.message : String(error)}`);
    return { scannedCount: p1.scannedCount, regexFlagged, skipped: p1.skipped.length, ranPhase2: false };
  }
}
