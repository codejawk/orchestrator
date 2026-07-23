import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * The security invariant, as a test.
 *
 * Planning runs on Gauss and only Gauss: intake, clarification, context
 * selection, prompt compilation, decomposition and routing all see raw prompts
 * and raw workspace content before anything has been classified or reviewed.
 * If any of that reached an external provider the whole design collapses, and
 * it would collapse quietly — an accidental import is not something code review
 * reliably catches.
 *
 * So this is a test rather than a convention.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLANNER_DIR = join(ROOT, 'src', 'planner');

/** Modules the planner must never reach, and why. */
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /adapters\/(claude|codex|gemini)/,
    reason: 'external model adapter — planning must never call an external provider',
  },
  {
    pattern: /\bexec\/process\b/,
    reason: 'process spawner — planning must not be able to launch a model CLI',
  },
  {
    pattern: /^(@anthropic-ai|openai|@google\/|@google-cloud)/,
    reason: 'external provider SDK',
  },
];

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Matches static imports, re-exports, and dynamic `import()`. */
const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? '');
}

test('src/planner exists so the guard is actually guarding something', () => {
  assert.ok(
    statSync(PLANNER_DIR).isDirectory(),
    'src/planner is missing — the isolation guard would pass vacuously',
  );
});

test('src/planner never imports an external model path', () => {
  const violations: string[] = [];

  for (const file of sourceFiles(PLANNER_DIR)) {
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      for (const { pattern, reason } of FORBIDDEN) {
        if (pattern.test(specifier)) {
          violations.push(
            `${relative(ROOT, file)} imports "${specifier}" (${reason})`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Planning must stay on Gauss.\n${violations.join('\n')}`,
  );
});

test('forbidden patterns match the specifiers they are meant to catch', () => {
  // Guards the guard: a typo'd regex would silently permit everything.
  const shouldMatch = [
    '../exec/adapters/claude.ts',
    './adapters/gemini',
    '../exec/process.ts',
    '@anthropic-ai/sdk',
    'openai',
  ];
  for (const specifier of shouldMatch) {
    assert.ok(
      FORBIDDEN.some(({ pattern }) => pattern.test(specifier)),
      `expected "${specifier}" to be forbidden`,
    );
  }

  const shouldNotMatch = ['../types/ir.ts', './gauss.ts', 'node:path', '../accounting/meter.ts'];
  for (const specifier of shouldNotMatch) {
    assert.ok(
      !FORBIDDEN.some(({ pattern }) => pattern.test(specifier)),
      `expected "${specifier}" to be allowed`,
    );
  }
});
