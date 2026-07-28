import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { buildDigest, scanFiles, type FileVerdict } from '../src/planner/scanner.ts';
import { extractJson, type GaussClient } from '../src/planner/gauss.ts';
import { findCycle, topologicalWaves, resolvePath } from '../src/planner/decompose.ts';
import { renderIR } from '../src/planner/compiler.ts';
import { compress, dedupeBlocks, stripCommentsPreservingStrings } from '../src/optimize/compress.ts';
import { skeletonFromSymbols, skeletonFromText, sliceRange } from '../src/optimize/skeleton.ts';
import { policyFor, scaleCap, extractEdits } from '../src/optimize/outputPolicy.ts';
import { materializeContext } from '../src/exec/context.ts';
import { RunLedger } from '../src/exec/ledger.ts';
import type { ContextRef, PromptIR, Subtask } from '../src/types/ir.ts';

/**
 * A fake Gauss. Scans and plans must be testable without a model endpoint,
 * otherwise the suite costs money and depends on an internal service being up.
 */
function fakeGauss(reply: (purpose: string, user: string) => unknown): GaussClient {
  const costs: unknown[] = [];
  return {
    model: 'gauss',
    costs,
    totalUsd: () => 0,
    complete: async (request: { purpose: string; user: string }) => ({
      text: JSON.stringify(reply(request.purpose, request.user)),
      data: reply(request.purpose, request.user),
      cost: {
        adapter: 'gauss',
        model: 'gauss',
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheCreationTokens: 0 },
        usd: 0,
        usdReported: false,
        durationMs: 1,
      },
      warnings: [],
    }),
  } as unknown as GaussClient;
}

describe('scanner', () => {
  test('never asks Gauss about a file the prefilter already decided is restricted', async () => {
    let asked = 0;
    const gauss = fakeGauss(() => {
      asked++;
      return { files: [] };
    });

    const report = await scanFiles(
      [{ path: 'boot/sboot.c', content: '-----BEGIN RSA PRIVATE KEY-----\nabc\n' }],
      gauss,
    );

    assert.equal(asked, 0, 'a private key is not a judgement call');
    assert.equal(report.files[0]?.tier, 'restricted');
    assert.equal(report.files[0]?.source, 'prefilter');
  });

  test('Gauss can raise a tier but never lower one', async () => {
    const gauss = fakeGauss(() => ({
      files: [{ path: 'docs/roadmap/plan.md', tier: 'public', reason: 'looks fine', unsure: false }],
    }));

    const report = await scanFiles(
      [{ path: 'docs/roadmap/plan.md', content: 'some notes' }],
      gauss,
    );

    // Path rule said confidential; the model saying "public" must not win.
    assert.equal(report.files[0]?.tier, 'confidential');
  });

  test('an unsure verdict is promoted to confidential', async () => {
    const gauss = fakeGauss(() => ({
      files: [{ path: 'src/a.ts', tier: 'internal', reason: 'unclear', unsure: true }],
    }));

    const report = await scanFiles([{ path: 'src/a.ts', content: 'export const a = 1;' }], gauss);

    assert.equal(report.files[0]?.tier, 'confidential');
  });

  test('a file Gauss did not answer for fails closed to restricted', async () => {
    const gauss = fakeGauss(() => ({ files: [] }));

    const report = await scanFiles([{ path: 'src/a.ts', content: 'export const a = 1;' }], gauss);

    assert.equal(report.files[0]?.tier, 'restricted');
    assert.match(report.warnings.join(' '), /no verdict/);
  });

  test('a failed scan batch fails closed rather than open', async () => {
    const gauss = {
      model: 'gauss',
      costs: [],
      totalUsd: () => 0,
      complete: async () => {
        throw new Error('gauss unreachable');
      },
    } as unknown as GaussClient;

    const report = await scanFiles([{ path: 'src/a.ts', content: 'x' }], gauss);

    assert.equal(report.files[0]?.tier, 'restricted');
    assert.match(report.warnings.join(' '), /treated as restricted/);
  });

  test('an invented path in the reply is ignored, not trusted', async () => {
    const gauss = fakeGauss(() => ({
      files: [{ path: 'does/not/exist.ts', tier: 'public', reason: 'x', unsure: false }],
    }));

    const report = await scanFiles([{ path: 'src/a.ts', content: 'x' }], gauss);

    assert.equal(report.files.length, 1);
    assert.equal(report.files[0]?.tier, 'restricted');
  });

  test('a successful verdict is cached, so unchanged files are never rescanned', async () => {
    let calls = 0;
    const gauss = fakeGauss(() => {
      calls++;
      return { files: [{ path: 'src/a.ts', tier: 'internal', reason: 'ordinary code', unsure: false }] };
    });
    const content = 'export const a = 1;';
    const cache = new Map<string, FileVerdict>();

    const first = await scanFiles([{ path: 'src/a.ts', content }], gauss, { cache });
    assert.equal(first.files[0]?.tier, 'internal');

    const before = calls;
    const second = await scanFiles([{ path: 'src/a.ts', content }], gauss, { cache });

    assert.equal(calls, before, 'unchanged content must not be rescanned');
    assert.equal(second.files[0]?.source, 'cached');
    assert.equal(second.files[0]?.tier, 'internal');
  });

  test('a failed classification is not cached, so it is retried next run', async () => {
    const cache = new Map<string, FileVerdict>();
    const silent = fakeGauss(() => ({ files: [] }));
    const content = 'export const a = 1;';

    // Fails closed to restricted...
    const first = await scanFiles([{ path: 'src/a.ts', content }], silent, { cache });
    assert.equal(first.files[0]?.tier, 'restricted');

    // ...but must not be remembered as restricted, or one bad batch would
    // permanently quarantine a file nobody ever looked at.
    const answering = fakeGauss(() => ({
      files: [{ path: 'src/a.ts', tier: 'internal', reason: 'ordinary code', unsure: false }],
    }));
    const second = await scanFiles([{ path: 'src/a.ts', content }], answering, { cache });

    assert.equal(second.files[0]?.tier, 'internal');
  });

  test('editing a file invalidates its cached verdict', async () => {
    const cache = new Map<string, FileVerdict>();
    const gauss = fakeGauss((_purpose, user) => ({
      files: [
        {
          path: 'src/a.ts',
          tier: user.includes('CONFIDENTIAL') ? 'restricted' : 'internal',
          reason: 'r',
          unsure: false,
        },
      ],
    }));

    const clean = await scanFiles([{ path: 'src/a.ts', content: 'const a = 1;' }], gauss, { cache });
    assert.equal(clean.files[0]?.tier, 'internal');

    const edited = await scanFiles(
      [{ path: 'src/a.ts', content: '// SAMSUNG CONFIDENTIAL\nconst a = 1;' }],
      gauss,
      { cache },
    );
    assert.equal(edited.files[0]?.tier, 'restricted');
  });
});

describe('digest', () => {
  test('sends short files whole', () => {
    const digest = buildDigest('a.ts', 'export const a = 1;', 400);
    assert.match(digest, /complete="true"/);
  });

  test('samples long files by relevance, not just position', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `const v${i} = ${i};`);
    lines[300] = '// SAMSUNG CONFIDENTIAL — do not distribute';
    const digest = buildDigest('big.ts', lines.join('\n'), 100);

    assert.match(digest, /complete="false"/);
    // The interesting line is 300 deep; head-and-tail alone would miss it.
    assert.match(digest, /CONFIDENTIAL/);
  });
});

describe('decomposition graph', () => {
  test('detects a cycle', () => {
    const cycle = findCycle([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]);
    assert.ok(cycle);
  });

  test('accepts a valid DAG', () => {
    assert.equal(
      findCycle([
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['a'] },
      ]),
      undefined,
    );
  });

  test('groups independent subtasks into one parallel wave', () => {
    const waves = topologicalWaves([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);

    assert.deepEqual(waves, [['a'], ['b', 'c'], ['d']]);
  });

  test('terminates instead of looping when given a cyclic graph', () => {
    const waves = topologicalWaves([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]);
    assert.equal(waves.length, 1);
  });
});

describe('IR rendering', () => {
  const ir: PromptIR = {
    goal: 'Add retry to the upload client',
    constraints: ['keep the existing signature'],
    acceptance: ['a failed upload retries three times'],
    nonGoals: ['do not touch the download path'],
    context: [],
    classification: { tier: 'internal', reasons: [] },
    rawPromptTokens: 50,
  };

  test('puts static sections first so the cache prefix stays stable', () => {
    const a = renderIR(ir, 'subtask one');
    const b = renderIR(ir, 'subtask two');
    const shared = commonPrefix(a, b);

    assert.ok(shared.includes('GOAL:'));
    assert.ok(shared.includes('DO NOT:'));
    assert.ok(!shared.includes('subtask one'));
  });

  test('includes non-goals, which is what suppresses unrequested work', () => {
    assert.match(renderIR(ir), /DO NOT:\n- do not touch the download path/);
  });
});

describe('compression', () => {
  test('strips a license header but keeps an ordinary leading comment', () => {
    const licensed = '/* Copyright 2026 Samsung. All rights reserved. */\nconst a = 1;';
    assert.ok(!compress(licensed).text.includes('Copyright'));

    const explanatory = '// This module talks to the upload service.\nconst a = 1;';
    assert.ok(compress(explanatory).text.includes('upload service'));
  });

  test('keeps comments by default, because they carry intent', () => {
    const source = '// why we do this\nconst a = 1;';
    assert.ok(compress(source).text.includes('why we do this'));
  });

  test('comment stripping does not corrupt URLs inside strings', () => {
    const source = 'const u = "https://example.com/x"; // trailing\nconst v = 2;';
    const stripped = stripCommentsPreservingStrings(source);

    assert.ok(stripped.includes('https://example.com/x'));
    assert.ok(!stripped.includes('trailing'));
  });

  test('elides the middle of long literals but keeps both ends', () => {
    const literal = 'A'.repeat(50) + 'MIDDLE' + 'B'.repeat(50);
    const result = compress(`const x = "${literal}";`, { elideLongLiterals: true, literalMaxChars: 20 });

    assert.match(result.text, /chars elided/);
    assert.ok(result.text.includes('AAAA'));
    assert.ok(result.text.includes('BBBB'));
  });

  test('deduplicates identical blocks regardless of whitespace', () => {
    const { kept, droppedKeys } = dedupeBlocks([
      { key: 'a', text: 'const x = 1;' },
      { key: 'b', text: 'const   x = 1;' },
      { key: 'c', text: 'const y = 2;' },
    ]);

    assert.equal(kept.length, 2);
    assert.deepEqual(droppedKeys, ['b']);
  });
});

describe('skeletons', () => {
  test('renders signatures from a symbol tree', () => {
    const skeleton = skeletonFromSymbols(
      'a.ts',
      [
        {
          name: 'Client',
          kind: 'class',
          line: 10,
          children: [{ name: 'upload', kind: 'method', line: 12, detail: '(f: File): Promise<void>' }],
        },
      ],
      400,
    );

    assert.match(skeleton, /class Client/);
    assert.match(skeleton, /method upload/);
    assert.match(skeleton, /:12/);
  });

  test('falls back to declaration matching for files no language server parses', () => {
    const makefile = 'obj-y += boot.o\n\nbuild:\n\t$(CC) -o boot boot.c\n';
    assert.match(skeletonFromText('Makefile', makefile), /build:/);
  });

  test('shows the head rather than nothing when no declaration matches', () => {
    const skeleton = skeletonFromText('notes.txt', 'just some prose\nand more prose\n');
    assert.match(skeleton, /just some prose/);
  });

  test('slices ranges with line numbers attached', () => {
    assert.equal(sliceRange('a\nb\nc\nd', [2, 3]), '2: b\n3: c');
  });
});

describe('output policy', () => {
  test('gives every structured kind a schema and a cap', () => {
    for (const kind of ['analyze', 'edit', 'test', 'review', 'refactor'] as const) {
      const policy = policyFor(kind);
      assert.ok(policy.schema, `${kind} needs a schema to suppress padding`);
      assert.ok(policy.maxTokens > 0);
    }
  });

  test('turns reasoning off for mechanical work', () => {
    assert.equal(policyFor('doc').reasoning, 'off');
    assert.equal(policyFor('review').reasoning, 'medium');
  });

  test('scales the cap sub-linearly with context', () => {
    assert.equal(scaleCap(1_000, 0), 1_000);
    assert.equal(scaleCap(1_000, 40_000), 2_000);
    // Beyond the knee it stops growing, so a huge context cannot uncap output.
    assert.equal(scaleCap(1_000, 400_000), 2_000);
  });

  test('extracts edits and rejects malformed entries', () => {
    const edits = extractEdits({
      edits: [
        { path: 'a.ts', search: 'x', replace: 'y' },
        { path: 'b.ts', search: 'x' },
        'nonsense',
      ],
    });
    assert.equal(edits.length, 1);
  });
});

describe('context materialization', () => {
  const read = async (path: string) =>
    ({
      'a.ts': 'export function alpha(): void {}\n// body\nconst hidden = 1;',
      'b.ts': 'export function beta(): void {}',
    })[path];

  test('skeleton mode sends signatures, not bodies', async () => {
    const result = await materializeContext([{ path: 'a.ts', mode: 'skeleton', estTokens: 10 }], read);

    assert.match(result.text, /mode="skeleton"/);
    assert.ok(!result.text.includes('const hidden'));
  });

  test('reports what a full send would have cost', async () => {
    const result = await materializeContext([{ path: 'a.ts', mode: 'skeleton', estTokens: 10 }], read);
    assert.ok(result.savedVersusFull >= 0);
  });

  test('records unreadable files instead of failing the run', async () => {
    const result = await materializeContext([{ path: 'missing.ts', mode: 'full', estTokens: 10 }], read);

    assert.deepEqual(result.included, []);
    assert.match(result.dropped[0]?.reason ?? '', /could not be read/);
  });

  test('respects the budget and says what it dropped', async () => {
    const result = await materializeContext(
      [
        { path: 'a.ts', mode: 'full', estTokens: 10 },
        { path: 'b.ts', mode: 'full', estTokens: 10 },
      ],
      read,
      { budgetTokens: 5 },
    );

    assert.ok(result.dropped.some((entry) => /budget/.test(entry.reason)));
  });
});

describe('ledger', () => {
  function subtask(id: string, consumes: string[] = []): Subtask {
    return {
      id,
      dependsOn: consumes,
      kind: 'analyze',
      goal: 'g',
      context: [],
      consumes,
      adapter: 'gauss',
      model: 'gauss',
      output: { format: 'json', maxTokens: 100, reasoning: 'off' },
      estimate: { inTokens: 0, outTokens: 0, usd: 0 },
    };
  }

  const ok = {
    ok: true as const,
    text: 'line one\nline two',
    cost: {
      adapter: 'gauss' as const,
      model: 'gauss',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0 },
      usd: 0,
      usdReported: false,
      durationMs: 1,
    },
    warnings: [],
  };

  test('passes summaries downstream but withholds bodies from non-dependents', () => {
    const ledger = new RunLedger();
    ledger.record(subtask('a'), { ...ok, structured: undefined });

    const unrelated = ledger.renderFor(subtask('b'));
    assert.match(unrelated.text, /line one/);
    assert.ok(!unrelated.text.includes('line two'), 'body must not leak into an unrelated subtask');

    const dependent = ledger.renderFor(subtask('c', ['a']));
    assert.ok(dependent.text.includes('line two'), 'a declared dependency does get the body');
  });

  test('turns structured edits into diff artifacts', () => {
    const ledger = new RunLedger();
    ledger.record(subtask('a'), {
      ...ok,
      structured: { edits: [{ path: 'x.ts', search: 'a', replace: 'b' }] },
    });

    const edits = ledger.allEdits();
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.path, 'x.ts');
  });

  test('records a failure as a note so downstream can see it happened', () => {
    const ledger = new RunLedger();
    ledger.record(subtask('a'), { ...ok, ok: false, error: 'timed out' });

    assert.match(ledger.snapshot().entries[0]?.summary ?? '', /timed out/);
  });

  test('honours the handoff budget instead of growing without bound', () => {
    const ledger = new RunLedger();
    for (let i = 0; i < 200; i++) {
      ledger.record(subtask(`s${i}`), { ...ok, text: `finding number ${i} with some detail` });
    }

    const rendered = ledger.renderFor(subtask('last'), 200);
    assert.ok(rendered.tokens <= 200);
    assert.match(rendered.text, /omitted \(budget\)/);
  });
});

describe('JSON extraction', () => {
  test('parses a bare object', () => {
    const result = extractJson<{ a: number }>('{"a":1}');
    assert.equal(result.ok && result.value.a, 1);
  });

  test('parses through a fenced block', () => {
    const result = extractJson<{ a: number }>('Here you go:\n```json\n{"a":1}\n```\nHope that helps!');
    assert.equal(result.ok && result.value.a, 1);
  });

  test('parses through surrounding prose without fences', () => {
    const result = extractJson<{ a: number }>('Sure! {"a":1} — let me know.');
    assert.equal(result.ok && result.value.a, 1);
  });

  test('reports failure rather than throwing', () => {
    const result = extractJson('not json at all');
    assert.equal(result.ok, false);
  });
});

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return a.slice(0, i);
}

describe('resolvePath (planner path normalization)', () => {
  const ctx = (path: string): ContextRef => ({ path, mode: 'full', estTokens: 10 });
  const available = new Map([['hello.c', ctx('hello.c')], ['src/util.c', ctx('src/util.c')]]);

  test('matches an absolute path the planner echoed against relative context', () => {
    assert.equal(resolvePath('/Users/md/Learn/C_Language/hello.c', available)?.path, 'hello.c');
  });
  test('matches an exact relative path', () => {
    assert.equal(resolvePath('src/util.c', available)?.path, 'src/util.c');
  });
  test('matches on basename when no suffix match', () => {
    assert.equal(resolvePath('/elsewhere/util.c', available)?.path, 'src/util.c');
  });
  test('returns undefined for a genuinely absent file', () => {
    assert.equal(resolvePath('nonexistent.py', available), undefined);
  });
});
