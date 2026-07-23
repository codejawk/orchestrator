import type { BaselineEstimate, PromptIR, RunAccounting, SavingsReport, Usage } from '../types/ir.ts';
import { sumUsage, totalTokens } from './meter.ts';
import type { PriceTable } from './pricing.ts';

/**
 * The counterfactual.
 *
 * We cannot know what the naive run would have cost without running it, so the
 * report never pretends otherwise: `source` is `'modeled'` until a real A/B run
 * replaces it, and every constant behind the model is exposed so a reader can
 * disagree with it.
 *
 * Defaults are deliberately conservative. An uncalibrated exploration
 * multiplier of 1.0 assumes a naive agentic run reads exactly the files we
 * selected and no more — which is certainly too generous to the baseline, and
 * therefore under-reports our savings. Under-claiming until calibrated is the
 * right failure direction for a number that leadership will scrutinize.
 */

export interface Calibration {
  explorationMultiplier: number;
  outputMultiplier: number;
  samples: number;
  calibratedAt?: string;
}

export const UNCALIBRATED: Readonly<Calibration> = Object.freeze({
  explorationMultiplier: 1.0,
  outputMultiplier: 1.0,
  samples: 0,
});

/** One measured A/B observation, kept so the multiplier can be refitted. */
export interface CalibrationSample {
  at: string;
  /** Input tokens the model predicted before any multiplier was applied. */
  predictedInputTokens: number;
  /** Input tokens the true naive run actually consumed. */
  measuredInputTokens: number;
  predictedOutputTokens: number;
  measuredOutputTokens: number;
}

/** Persistence is injected so this module stays free of vscode imports. */
export interface CalibrationStore {
  load(): CalibrationSample[];
  save(samples: CalibrationSample[]): Promise<void>;
}

const MAX_SAMPLES = 200;

/**
 * Fits multipliers as the ratio of measured to predicted, using the median
 * rather than the mean. Agentic exploration is heavy-tailed — one run that
 * spidered an entire monorepo would drag a mean somewhere indefensible.
 */
export function fitCalibration(samples: CalibrationSample[]): Calibration {
  if (samples.length === 0) {
    return { ...UNCALIBRATED };
  }
  const ratios = (pick: (s: CalibrationSample) => [number, number]): number => {
    const values = samples
      .map(pick)
      .filter(([predicted]) => predicted > 0)
      .map(([predicted, measured]) => measured / predicted)
      .sort((a, b) => a - b);
    if (values.length === 0) {
      return 1.0;
    }
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0
      ? ((values[mid - 1] ?? 1) + (values[mid] ?? 1)) / 2
      : (values[mid] ?? 1);
  };

  return {
    explorationMultiplier: ratios((s) => [s.predictedInputTokens, s.measuredInputTokens]),
    outputMultiplier: ratios((s) => [s.predictedOutputTokens, s.measuredOutputTokens]),
    samples: samples.length,
    calibratedAt: samples[samples.length - 1]?.at,
  };
}

export function appendSample(
  existing: CalibrationSample[],
  sample: CalibrationSample,
): CalibrationSample[] {
  return [...existing, sample].slice(-MAX_SAMPLES);
}

/** Whether this run should also pay for a true baseline, to keep the fit fresh. */
export function shouldSampleBaseline(rate: number, random: () => number = Math.random): boolean {
  if (!Number.isFinite(rate) || rate <= 0) {
    return false;
  }
  return random() < Math.min(rate, 1);
}

export interface BaselineInputs {
  ir: PromptIR;
  /**
   * Full token cost of every file the orchestrated run touched, as if sent
   * whole. This is the saving skeletonization and slicing produce, so it is
   * the core of the estimate.
   */
  fullContextTokens: number;
  /** Output tokens the orchestrated run actually produced. */
  observedOutputTokens: number;
  frontierModel: string;
  calibration: Calibration;
  prices: PriceTable;
}

/**
 * Models what a single frontier-model run over the raw prompt and whole files
 * would have cost.
 *
 * Deliberately excluded: retries, and the cost of the run the developer would
 * have thrown away because the prompt was ambiguous. Both are real and both
 * favour us. Wasted runs are reported separately by `estimateAvoidedRuns` so
 * the two claims can be audited independently rather than blended into one
 * number nobody can check.
 */
export function modelBaseline(inputs: BaselineInputs): BaselineEstimate {
  const { ir, fullContextTokens, observedOutputTokens, frontierModel, calibration, prices } = inputs;

  const predictedInput = ir.rawPromptTokens + fullContextTokens;
  const inputTokens = Math.round(predictedInput * calibration.explorationMultiplier);
  const outputTokens = Math.round(observedOutputTokens * calibration.outputMultiplier);

  const usage: Usage = {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
  };

  return {
    usd: prices.cost(frontierModel, usage),
    usage,
    model: frontierModel,
    source: 'modeled',
    explorationMultiplier: calibration.explorationMultiplier,
    calibrationSamples: calibration.samples,
    calibratedAt: calibration.calibratedAt,
  };
}

/** Wraps a genuinely measured A/B run so the report can mark it as such. */
export function measuredBaseline(
  usage: Usage,
  usd: number,
  model: string,
  calibration: Calibration,
): BaselineEstimate {
  return {
    usd,
    usage,
    model,
    source: 'measured',
    explorationMultiplier: calibration.explorationMultiplier,
    calibrationSamples: calibration.samples,
    calibratedAt: calibration.calibratedAt,
  };
}

/**
 * Total actual spend, planning included.
 *
 * Counting the Gauss planning overhead is not optional. Omitting it would make
 * the headline number a lie, and the first person to audit the report would be
 * right to throw the whole project out.
 */
export function actualSpend(run: RunAccounting): { usd: number; usage: Usage } {
  const all = [...run.planning, ...run.execution];
  return {
    usd: all.reduce((sum, record) => sum + record.usd, 0),
    usage: sumUsage(all.map((record) => record.usage)),
  };
}

export function buildSavingsReport(
  run: RunAccounting,
  baseline: BaselineEstimate,
): SavingsReport {
  const actual = actualSpend(run);
  const netUsd = baseline.usd - actual.usd;
  return {
    planId: run.planId,
    actualUsd: actual.usd,
    actualUsage: actual.usage,
    baseline,
    netUsd,
    netFraction: baseline.usd > 0 ? netUsd / baseline.usd : 0,
  };
}

/**
 * The clarification saving, reported as its own line.
 *
 * This is a different kind of claim from the token arithmetic above — it counts
 * runs that never happened — so it is derived separately and must never be
 * folded into `netUsd`. `avoidedRuns` comes from counting sessions where
 * clarification materially changed the compiled goal.
 */
export function estimateAvoidedRuns(args: {
  avoidedRuns: number;
  medianRunUsd: number;
}): { avoidedRuns: number; usd: number } {
  return {
    avoidedRuns: args.avoidedRuns,
    usd: args.avoidedRuns * args.medianRunUsd,
  };
}

/** Convenience for the report panel. */
export function describeUsage(usage: Usage): string {
  return `${totalTokens(usage).toLocaleString()} tokens (${usage.inputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out, ${usage.cachedInputTokens.toLocaleString()} cached)`;
}
