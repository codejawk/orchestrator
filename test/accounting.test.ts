import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  meterClaudeJson,
  meterCodexJsonl,
  meterGeminiJson,
  sumUsage,
  toCostRecord,
  totalTokens,
} from '../src/accounting/meter.ts';
import { PriceTable } from '../src/accounting/pricing.ts';
import {
  actualSpend,
  buildSavingsReport,
  fitCalibration,
  modelBaseline,
  shouldSampleBaseline,
  UNCALIBRATED,
  type CalibrationSample,
} from '../src/accounting/baseline.ts';
import type { CostRecord, PromptIR, RunAccounting } from '../src/types/ir.ts';

describe('meter', () => {
  test('reads Claude result objects including cache fields', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 4231,
      num_turns: 2,
      result: 'done',
      session_id: 'sess-1',
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 8000,
        output_tokens: 450,
      },
      modelUsage: { 'claude-sonnet-5': { inputTokens: 1200 } },
    });

    const result = meterClaudeJson(stdout);

    assert.equal(result.usage.inputTokens, 1200);
    assert.equal(result.usage.outputTokens, 450);
    assert.equal(result.usage.cachedInputTokens, 8000);
    assert.equal(result.usage.cacheCreationTokens, 300);
    assert.equal(result.reportedUsd, 0.0421);
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(result.model, 'claude-sonnet-5');
    assert.deepEqual(result.warnings, []);
  });

  test('accumulates Codex usage across every turn', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t-9"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"assistant_message"}}',
      '{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":4000,"output_tokens":220}}',
      '{"type":"turn.completed","usage":{"input_tokens":150,"cached_input_tokens":4900,"output_tokens":60}}',
    ].join('\n');

    const result = meterCodexJsonl(stdout);

    assert.equal(result.usage.inputTokens, 1050);
    assert.equal(result.usage.outputTokens, 280);
    assert.equal(result.usage.cachedInputTokens, 8900);
    assert.equal(result.sessionId, 't-9');
  });

  test('warns rather than under-counting when Codex emits no turn.completed', () => {
    // Reproduces openai/codex#15451: --json silently ignored with tools active.
    const result = meterCodexJsonl('Some plain prose the CLI printed instead.\n');

    assert.equal(totalTokens(result.usage), 0);
    assert.match(result.warnings.join(' '), /usage unavailable/);
  });

  test('skips malformed JSONL lines without abandoning the stream', () => {
    const stdout = [
      'not json at all',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
    ].join('\n');

    assert.equal(meterCodexJsonl(stdout).usage.inputTokens, 10);
  });

  test('finds a nested usage node in Gemini output', () => {
    const stdout = JSON.stringify({
      response: 'ok',
      stats: { models: { 'gemini-2.5-flash': { tokens: { input_tokens: 77, output_tokens: 12 } } } },
    });

    const result = meterGeminiJson(stdout);

    assert.equal(result.usage.inputTokens, 77);
    assert.equal(result.usage.outputTokens, 12);
    assert.equal(result.text, 'ok');
  });

  test('degrades to a warning on unparseable stdout instead of throwing', () => {
    for (const meter of [meterClaudeJson, meterGeminiJson]) {
      const result = meter('<html>gateway timeout</html>');
      assert.equal(totalTokens(result.usage), 0);
      assert.equal(result.warnings.length, 1);
    }
  });
});

describe('pricing', () => {
  test('resolves aliases and dated model suffixes', () => {
    const prices = new PriceTable();
    assert.equal(prices.lookup('haiku')?.input, prices.lookup('claude-haiku-4-5')?.input);
    assert.ok(prices.lookup('claude-haiku-4-5-20251001'));
  });

  test('returns undefined for unknown models so callers can flag rather than guess', () => {
    assert.equal(new PriceTable().lookup('some-future-model'), undefined);
  });

  test('charges cache reads at the multiplier, not the full input rate', () => {
    const prices = new PriceTable({ test: { input: 10, output: 0, cacheReadMultiplier: 0.1 } });
    const cost = prices.cost('test', {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
      cacheCreationTokens: 0,
    });
    assert.equal(cost, 1);
  });

  test('settings overrides win over the built-in table', () => {
    const prices = new PriceTable({ 'claude-opus-4-8': { input: 99 } });
    assert.equal(prices.lookup('claude-opus-4-8')?.input, 99);
  });
});

describe('cost records', () => {
  const prices = new PriceTable();

  test('prefers provider-reported cost and says so', () => {
    const record = toCostRecord({
      adapter: 'claude',
      requestedModel: 'sonnet',
      meter: meterClaudeJson(
        JSON.stringify({ total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 1 } }),
      ),
      durationMs: 100,
      prices,
    });

    assert.equal(record.usd, 0.5);
    assert.equal(record.usdReported, true);
  });

  test('derives cost from the table when the provider reports none', () => {
    const record = toCostRecord({
      adapter: 'codex',
      requestedModel: 'gpt-5',
      meter: meterCodexJsonl(
        '{"type":"turn.completed","usage":{"input_tokens":1000000,"output_tokens":0}}',
      ),
      durationMs: 100,
      prices,
    });

    assert.equal(record.usdReported, false);
    assert.equal(record.usd, 1.25);
  });
});

describe('baseline', () => {
  const prices = new PriceTable();
  const ir: PromptIR = {
    goal: 'g',
    constraints: [],
    acceptance: [],
    nonGoals: [],
    context: [],
    classification: { tier: 'internal', reasons: [] },
    rawPromptTokens: 500,
  };

  test('an uncalibrated multiplier under-claims rather than over-claims', () => {
    const estimate = modelBaseline({
      ir,
      fullContextTokens: 9_500,
      observedOutputTokens: 1_000,
      frontierModel: 'claude-opus-4-8',
      calibration: UNCALIBRATED,
      prices,
    });

    // No inflation applied: exactly prompt + context, nothing invented.
    assert.equal(estimate.usage.inputTokens, 10_000);
    assert.equal(estimate.usage.outputTokens, 1_000);
    assert.equal(estimate.source, 'modeled');
    assert.equal(estimate.calibrationSamples, 0);
  });

  test('fits the multiplier from the median, resisting one runaway run', () => {
    const sample = (measured: number): CalibrationSample => ({
      at: '2026-07-23T00:00:00Z',
      predictedInputTokens: 1_000,
      measuredInputTokens: measured,
      predictedOutputTokens: 100,
      measuredOutputTokens: 100,
    });

    const calibration = fitCalibration([
      sample(2_000),
      sample(2_400),
      sample(90_000), // one run that spidered the monorepo
    ]);

    assert.equal(calibration.explorationMultiplier, 2.4);
    assert.equal(calibration.samples, 3);
    assert.ok(calibration.calibratedAt);
  });

  test('no samples means no calibration, not a guess', () => {
    assert.deepEqual(fitCalibration([]), { ...UNCALIBRATED });
  });

  test('actual spend includes Gauss planning overhead', () => {
    const record = (usd: number, adapter: CostRecord['adapter']): CostRecord => ({
      adapter,
      model: 'm',
      usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0 },
      usd,
      usdReported: true,
      durationMs: 1,
    });

    const run: RunAccounting = {
      planId: 'p1',
      planning: [record(0.02, 'gauss'), record(0.01, 'gauss')],
      execution: [record(0.5, 'claude')],
    };

    // 0.53, not 0.5. Hiding the planning cost would make the report a lie.
    assert.equal(Number(actualSpend(run).usd.toFixed(4)), 0.53);
    assert.equal(totalTokens(sumUsage([...run.planning, ...run.execution].map((r) => r.usage))), 60);
  });

  test('reports a negative saving when orchestration cost more than the baseline', () => {
    const run: RunAccounting = {
      planId: 'p2',
      planning: [
        {
          adapter: 'gauss',
          model: 'gauss',
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 },
          usd: 1.0,
          usdReported: true,
          durationMs: 1,
        },
      ],
      execution: [],
    };

    const report = buildSavingsReport(run, {
      usd: 0.4,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 },
      model: 'claude-opus-4-8',
      source: 'modeled',
      explorationMultiplier: 1,
      calibrationSamples: 0,
    });

    assert.ok(report.netUsd < 0, 'overhead exceeding savings must surface, not be clamped');
    assert.ok(report.netFraction < 0);
  });

  test('sampling honours the configured rate at both extremes', () => {
    assert.equal(shouldSampleBaseline(0), false);
    assert.equal(shouldSampleBaseline(1, () => 0.999), true);
    assert.equal(shouldSampleBaseline(0.05, () => 0.5), false);
    assert.equal(shouldSampleBaseline(0.05, () => 0.01), true);
  });
});
