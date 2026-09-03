import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { fileOutline } from '../src/outline.ts';

describe('fileOutline', () => {
  test('extracts python defs and classes, not bodies', () => {
    const src = `import os\n\nclass Foo:\n    def bar(self, x):\n        y = x + 1\n        return y\n\ndef top(a, b):\n    return a + b\n`;
    const sigs = fileOutline('m.py', src);
    assert.ok(sigs.some((s) => s.includes('class Foo')));
    assert.ok(sigs.some((s) => s.includes('def bar')));
    assert.ok(sigs.some((s) => s.includes('def top')));
    assert.ok(!sigs.some((s) => s.includes('y = x + 1'))); // body excluded
  });

  test('extracts ts top-level defs but skips locals and control flow', () => {
    const src = `export function run(a: number) {\n  const local = 1;\n  if (a) { return local; }\n}\nexport interface Opts { x: number }\nconst TOP = 5;\n`;
    const sigs = fileOutline('m.ts', src);
    assert.ok(sigs.some((s) => s.includes('export function run')));
    assert.ok(sigs.some((s) => s.includes('export interface Opts')));
    assert.ok(sigs.some((s) => s.includes('const TOP')));
    assert.ok(!sigs.some((s) => s.includes('const local'))); // indented local excluded
    assert.ok(!sigs.some((s) => s.startsWith('if'))); // control flow excluded
  });

  test('returns nothing for an unknown extension', () => {
    assert.deepEqual(fileOutline('data.bin', 'anything'), []);
  });
});
