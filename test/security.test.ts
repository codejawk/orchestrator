import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
  codenameRule,
  DEFAULT_RULES,
  findHighEntropyStrings,
  prefilter,
  shannonEntropy,
} from '../src/policy/patterns.ts';
import { ApprovalStore, partitionByRouting, type KeyValueStore } from '../src/policy/approvals.ts';
import { assertRoutingSafe, costTierFor, route, DEFAULT_TIERS } from '../src/planner/router.ts';
import { PriceTable } from '../src/accounting/pricing.ts';
import { hashContent, type FileVerdict } from '../src/planner/scanner.ts';
import type { AdapterId, ContextRef, Subtask, Tier } from '../src/types/ir.ts';
import type { DraftSubtask } from '../src/planner/decompose.ts';

/**
 * The security path. These tests exist because every failure here is silent and
 * irreversible: bytes that reach a provider cannot be recalled, and nothing in
 * the UI would show that it happened.
 */

function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key, value) => {
      data.set(key, value);
    },
  };
}

function verdict(path: string, content: string, tier: Tier): FileVerdict {
  return {
    path,
    contentHash: hashContent(content),
    tier,
    reasons: [],
    source: 'gauss',
    estTokens: 100,
  };
}

describe('prefilter', () => {
  test('catches private keys regardless of path', () => {
    const result = prefilter(
      'docs/notes.md',
      'here is the key\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n',
    );
    assert.equal(result.tier, 'restricted');
    assert.equal(result.decided, true);
  });

  test('classifies bootloader and TEE paths as restricted', () => {
    for (const path of [
      'platform/bootloader/main.c',
      'vendor/sboot/init.S',
      'security/teegris/ta_keymaster.c',
      'core/knox/policy.c',
    ]) {
      assert.equal(prefilter(path, 'int main() {}').tier, 'restricted', path);
    }
  });

  test('catches secure-boot vocabulary in otherwise unremarkable files', () => {
    const result = prefilter('src/util.c', 'if (avb_verify_slot(x)) { rollback_index++; }');
    assert.equal(result.tier, 'restricted');
  });

  test('does not flag ordinary application code', () => {
    const result = prefilter('src/ui/Button.tsx', 'export const Button = () => <button/>;');
    assert.equal(result.tier, 'public');
    assert.equal(result.decided, false);
  });

  test('takes the highest tier when several rules fire', () => {
    // Roadmap path is confidential, bootloader content is restricted.
    const result = prefilter('docs/roadmap/boot.md', 'notes on secure_boot and dm-verity');
    assert.equal(result.tier, 'restricted');
  });

  test('codename rule requires a word boundary', () => {
    const rule = codenameRule(['Nightfall', 'ab']);
    assert.ok(rule);
    assert.equal(rule.pattern.test('project Nightfall ships Q3'), true);
    assert.equal(rule.pattern.test('nightfallen'), false);
    // Two-character entries are dropped as too noisy to be useful.
    assert.equal(rule.pattern.test('ab'), false);
  });

  test('codenames raise a plain file to confidential', () => {
    const rules = [...DEFAULT_RULES, codenameRule(['Nightfall'])!];
    const result = prefilter('src/config.ts', 'const target = "Nightfall";', rules);
    assert.equal(result.tier, 'confidential');
  });

  test('entropy check ignores repetitive strings and catches random ones', () => {
    assert.ok(shannonEntropy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') < 1);
    assert.ok(shannonEntropy('J8xQ2mVpL9zR4tN7bW3yK6cF1aH5dG0s') > 4.2);

    assert.equal(findHighEntropyStrings('const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";').length, 0);
    assert.equal(findHighEntropyStrings('const k = "J8xQ2mVpL9zR4tN7bW3yK6cF1aH5dG0s";').length, 1);
  });
});

describe('approvals', () => {
  test('approval is void once the file changes', async () => {
    const store = new ApprovalStore(memoryStore());
    const original = verdict('src/a.ts', 'v1', 'internal');

    await store.record(original, 'external-allowed');
    assert.equal(store.route(original).externalAllowed, true);

    const edited = verdict('src/a.ts', 'v2 with a private key pasted in', 'internal');
    const routing = store.route(edited);

    assert.equal(routing.externalAllowed, false);
    assert.match(routing.reason, /changed since you approved/);
  });

  test('restricted files cannot be approved without the override setting', async () => {
    const store = new ApprovalStore(memoryStore(), false);
    const result = await store.record(verdict('boot/sboot.c', 'x', 'restricted'), 'external-allowed');

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /allowRestrictedOverride/);
  });

  test('the override permits it and records that it was an override', async () => {
    const store = new ApprovalStore(memoryStore(), true);
    const file = verdict('boot/sboot.c', 'x', 'restricted');
    const result = await store.record(file, 'external-allowed');

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.approval.override, true);
    assert.match(store.route(file).reason, /overriding a restricted verdict/);
  });

  test('an explicit gauss-only decision beats a benign tier', async () => {
    const store = new ApprovalStore(memoryStore());
    const file = verdict('src/a.ts', 'x', 'public');

    await store.record(file, 'gauss-only');

    assert.equal(store.route(file).externalAllowed, false);
  });

  test('unreviewed files default to Gauss-only', () => {
    const store = new ApprovalStore(memoryStore());
    const routing = store.route(verdict('src/new.ts', 'x', 'public'));

    assert.equal(routing.externalAllowed, false);
    assert.match(routing.reason, /not yet approved/);
  });

  test('revoking clears everything back to Gauss-only', async () => {
    const store = new ApprovalStore(memoryStore());
    const file = verdict('src/a.ts', 'x', 'internal');
    await store.record(file, 'external-allowed');

    await store.revokeAll();

    assert.equal(store.route(file).externalAllowed, false);
    assert.equal(store.all().length, 0);
  });

  test('partitioning splits a scanned set by what may leave', async () => {
    const store = new ApprovalStore(memoryStore());
    const ok = verdict('src/a.ts', 'a', 'internal');
    const no = verdict('boot/b.c', 'b', 'restricted');
    await store.record(ok, 'external-allowed');

    const { external, gaussOnly } = partitionByRouting([ok, no], store);

    assert.deepEqual(external.map((r) => r.path), ['src/a.ts']);
    assert.deepEqual(gaussOnly.map((r) => r.path), ['boot/b.c']);
  });
});

describe('router', () => {
  const prices = new PriceTable();

  function draft(overrides: Partial<DraftSubtask> = {}): DraftSubtask {
    return {
      id: 't1',
      goal: 'do the thing',
      kind: 'edit',
      difficulty: 'standard',
      context: [],
      dependsOn: [],
      ...overrides,
    };
  }

  function ref(path: string): ContextRef {
    return { path, mode: 'full', estTokens: 100 };
  }

  const allAdapters = new Set<AdapterId>(['claude', 'codex', 'gemini', 'gauss']);

  test('a single unapproved file pins the whole subtask to Gauss', () => {
    const result = route({
      drafts: [draft({ context: [ref('src/ok.ts'), ref('boot/secret.c')] })],
      gaussOnlyPaths: new Set(['boot/secret.c']),
      availableAdapters: allAdapters,
      prices,
      sharedPrefixTokens: 0,
    });

    assert.equal(result.subtasks[0]?.adapter, 'gauss');
    assert.match(result.subtasks[0]?.routingNote ?? '', /not approved for external use/);
    assert.deepEqual(result.policyPinned[0]?.paths, ['boot/secret.c']);
  });

  test('policy beats cost even for a trivial subtask', () => {
    // A mechanical doc task would otherwise route to the cheap tier.
    const result = route({
      drafts: [draft({ kind: 'doc', difficulty: 'mechanical', context: [ref('boot/x.c')] })],
      gaussOnlyPaths: new Set(['boot/x.c']),
      availableAdapters: allAdapters,
      prices,
      sharedPrefixTokens: 0,
    });

    assert.equal(result.subtasks[0]?.adapter, 'gauss');
  });

  test('difficulty and kind pick the cost tier', () => {
    assert.equal(costTierFor('doc', 'mechanical'), 'cheap');
    assert.equal(costTierFor('edit', 'standard'), 'standard');
    assert.equal(costTierFor('edit', 'hard'), 'frontier');
    // Review is promoted: a missed security problem costs more than it saved.
    assert.equal(costTierFor('review', 'standard'), 'frontier');
    assert.equal(costTierFor('review', 'mechanical'), 'standard');
  });

  test('falls back within a tier when the preferred adapter is missing', () => {
    const result = route({
      drafts: [draft({ difficulty: 'standard' })],
      gaussOnlyPaths: new Set(),
      availableAdapters: new Set<AdapterId>(['codex', 'gauss']),
      tiers: DEFAULT_TIERS,
      prices,
      sharedPrefixTokens: 0,
    });

    assert.equal(result.subtasks[0]?.adapter, 'codex');
    assert.match(result.subtasks[0]?.routingNote ?? '', /claude unavailable/);
  });

  test('falls back to Gauss and warns when a whole tier is unavailable', () => {
    const result = route({
      drafts: [draft()],
      gaussOnlyPaths: new Set(),
      availableAdapters: new Set<AdapterId>(['gauss']),
      prices,
      sharedPrefixTokens: 0,
    });

    assert.equal(result.subtasks[0]?.adapter, 'gauss');
    assert.match(result.warnings.join(' '), /no adapter available/);
  });

  test('a tainted session pins every subtask to Gauss, files notwithstanding', () => {
    const result = route({
      drafts: [
        draft({ id: 'a', kind: 'doc', difficulty: 'mechanical' }),
        draft({ id: 'b', kind: 'edit', difficulty: 'hard', context: [ref('src/fine.ts')] }),
      ],
      // Every file here is approved. It makes no difference: the sensitive text
      // is in the prompt, which rides in the shared prefix of every subtask.
      gaussOnlyPaths: new Set(),
      availableAdapters: allAdapters,
      prices,
      sharedPrefixTokens: 0,
      forceGauss: { reason: 'Your message reads as confidential.' },
    });

    assert.deepEqual(result.subtasks.map((s) => s.adapter), ['gauss', 'gauss']);
    assert.match(result.subtasks[0]?.routingNote ?? '', /reads as confidential/);
    assert.equal(result.policyPinned.length, 2);
  });

  test('taint outranks the per-file check rather than racing it', () => {
    const result = route({
      drafts: [draft({ context: [ref('boot/x.c')] })],
      gaussOnlyPaths: new Set(['boot/x.c']),
      availableAdapters: allAdapters,
      prices,
      sharedPrefixTokens: 0,
      forceGauss: { reason: 'tainted' },
    });

    assert.equal(result.subtasks[0]?.adapter, 'gauss');
    assert.equal(result.subtasks[0]?.routingNote, 'tainted');
  });

  test('the pre-dispatch check throws rather than leaking', () => {
    const subtask: Subtask = {
      id: 'bad',
      dependsOn: [],
      kind: 'edit',
      goal: 'g',
      context: [ref('boot/secret.c')],
      consumes: [],
      adapter: 'claude',
      model: 'sonnet',
      output: { format: 'json', maxTokens: 100, reasoning: 'off' },
      estimate: { inTokens: 0, outTokens: 0, usd: 0 },
    };

    assert.throws(
      () => assertRoutingSafe(subtask, new Set(['boot/secret.c'])),
      /not approved for external use/,
    );
  });

  test('the pre-dispatch check permits Gauss to see anything', () => {
    const subtask: Subtask = {
      id: 'ok',
      dependsOn: [],
      kind: 'edit',
      goal: 'g',
      context: [ref('boot/secret.c')],
      consumes: [],
      adapter: 'gauss',
      model: 'gauss',
      output: { format: 'json', maxTokens: 100, reasoning: 'off' },
      estimate: { inTokens: 0, outTokens: 0, usd: 0 },
    };

    assert.doesNotThrow(() => assertRoutingSafe(subtask, new Set(['boot/secret.c'])));
  });
});
