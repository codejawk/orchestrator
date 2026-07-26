import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { synthesize } from '../src/planner/synthesize.ts';
import { resolveBare } from '../src/exec/bareAuth.ts';
import type { GaussClient } from '../src/planner/gauss.ts';
import type { Ledger, PromptIR } from '../src/types/ir.ts';

const ir: PromptIR = {
  goal: 'diagnose rapid battery drain during charging',
  constraints: [],
  acceptance: ['a specific cause is identified with file:line'],
  nonGoals: [],
  context: [],
  classification: { tier: 'internal', reasons: [] },
  rawPromptTokens: 100,
};

function fakeGauss(capture?: (user: string) => void): GaussClient {
  return {
    model: 'gauss',
    costs: [],
    totalUsd: () => 0,
    complete: async (req: { user: string }) => {
      capture?.(req.user);
      return {
        text: 'Root cause: charging current is not reduced when warm (max77705_charger.c:842).',
        cost: {
          adapter: 'gauss' as const,
          model: 'gauss',
          usage: { inputTokens: 50, outputTokens: 20, cachedInputTokens: 0, cacheCreationTokens: 0 },
          usd: 0.001,
          usdReported: false,
          durationMs: 5,
        },
        warnings: [],
      };
    },
  } as unknown as GaussClient;
}

function ledger(entries: Ledger['entries']): Ledger {
  return { entries };
}

describe('synthesize (step 6 combine)', () => {
  test('combines multiple subtask results into one answer', async () => {
    let sawUser = '';
    const gauss = fakeGauss((u) => (sawUser = u));

    const result = await synthesize(
      ir,
      ledger([
        { id: 'f1', producedBy: 't1', kind: 'finding', summary: 'current not reduced when warm', refs: ['max77705_charger.c:842'], tokens: 10 },
        { id: 'f2', producedBy: 't2', kind: 'finding', summary: 'monitor work re-arms every 10s', refs: ['sec_battery.c:2213'], tokens: 10 },
      ]),
      gauss,
    );

    assert.ok(result);
    assert.match(result.text, /Root cause/);
    // The goal and both fragments must reach the combine call.
    assert.match(sawUser, /battery drain/);
    assert.match(sawUser, /current not reduced when warm/);
    assert.match(sawUser, /monitor work re-arms/);
  });

  test('returns undefined for a single fragment — nothing to combine', async () => {
    const result = await synthesize(
      ir,
      ledger([{ id: 'f1', producedBy: 't1', kind: 'note', summary: 'done', refs: [], tokens: 1 }]),
      fakeGauss(),
    );
    assert.equal(result, undefined);
  });

  test('carries the combine call cost so the report can count it', async () => {
    const result = await synthesize(
      ir,
      ledger([
        { id: 'a', producedBy: 't1', kind: 'note', summary: 'one', refs: [], tokens: 1 },
        { id: 'b', producedBy: 't2', kind: 'note', summary: 'two', refs: [], tokens: 1 },
      ]),
      fakeGauss(),
    );
    assert.equal(result?.cost.usd, 0.001);
    assert.equal(result?.cost.adapter, 'gauss');
  });
});

describe('resolveBare (subscription auth)', () => {
  test('auto: off when no API-key-style credential is present', () => {
    // The Pro/Max subscription case — --bare would break auth, so it is disabled.
    assert.equal(resolveBare('auto', {}), false);
  });

  test('auto: on when an API key or gateway token is present', () => {
    assert.equal(resolveBare('auto', { ANTHROPIC_API_KEY: 'sk-x' }), true);
    assert.equal(resolveBare('auto', { ANTHROPIC_AUTH_TOKEN: 'tok' }), true);
    assert.equal(resolveBare('auto', { CLAUDE_CODE_USE_BEDROCK: '1' }), true);
  });

  test('explicit on/off override the auto detection', () => {
    assert.equal(resolveBare('off', { ANTHROPIC_API_KEY: 'sk-x' }), false);
    assert.equal(resolveBare('on', {}), true);
  });
});
