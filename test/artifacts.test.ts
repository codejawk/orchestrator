import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFiles, parseEdits, applyEdits, writeFiles, runDir } from '../src/artifacts.ts';

describe('parseFiles', () => {
  test('extracts one file from markers', () => {
    const files = parseFiles('===FILE: a/b.py===\nprint(1)\n===END FILE===');
    assert.equal(files.length, 1);
    assert.equal(files[0]!.path, 'a/b.py');
    assert.match(files[0]!.contents, /print\(1\)/);
  });

  test('strips an accidental code fence around the body', () => {
    const files = parseFiles('===FILE: x.ts===\n```ts\nconst a = 1;\n```\n===END FILE===');
    assert.equal(files[0]!.contents.trim(), 'const a = 1;');
  });

  test('extracts multiple files', () => {
    const files = parseFiles('===FILE: a.py===\n1\n===END FILE===\ntext\n===FILE: b.py===\n2\n===END FILE===');
    assert.deepEqual(files.map((f) => f.path), ['a.py', 'b.py']);
  });

  test('ignores prose with no markers', () => {
    assert.equal(parseFiles('just an explanation, no files').length, 0);
  });
});

describe('writeFiles safety', () => {
  test('creates new, leaves identical unchanged, backs up changed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-wf-'));
    const backupDir = join(runDir(root), 'backup');

    // create
    let a = await writeFiles(root, [{ path: 'x.txt', contents: 'v1\n' }], { mode: 'backup', backupDir });
    assert.equal(a[0]!.status, 'created');
    assert.equal(readFileSync(join(root, 'x.txt'), 'utf8'), 'v1\n');

    // identical → unchanged
    a = await writeFiles(root, [{ path: 'x.txt', contents: 'v1\n' }], { mode: 'backup', backupDir });
    assert.equal(a[0]!.status, 'unchanged');

    // changed → updated + backup saved
    a = await writeFiles(root, [{ path: 'x.txt', contents: 'v2\n' }], { mode: 'backup', backupDir });
    assert.equal(a[0]!.status, 'updated');
    assert.equal(readFileSync(join(root, 'x.txt'), 'utf8'), 'v2\n');
    assert.equal(readFileSync(join(backupDir, 'x.txt'), 'utf8'), 'v1\n');
  });

  test('skip mode keeps the existing file and writes alongside', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-wf2-'));
    await writeFiles(root, [{ path: 'y.txt', contents: 'orig\n' }], { mode: 'skip', backupDir: join(root, 'b') });
    const a = await writeFiles(root, [{ path: 'y.txt', contents: 'new\n' }], { mode: 'skip', backupDir: join(root, 'b') });
    assert.equal(a[0]!.status, 'kept-existing');
    assert.equal(readFileSync(join(root, 'y.txt'), 'utf8'), 'orig\n');
    assert.ok(existsSync(join(root, 'y.txt.orchestrator-new')));
  });

  test('rejects a path that escapes the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-wf3-'));
    const a = await writeFiles(root, [{ path: '../evil.txt', contents: 'x' }], { mode: 'backup', backupDir: join(root, 'b') });
    assert.equal(a.length, 0);
    assert.ok(!existsSync(join(root, '..', 'evil.txt')));
  });
});

describe('parseEdits + applyEdits', () => {
  const block = (path: string, search: string, replace: string) =>
    `===EDIT: ${path}===\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n===END EDIT===`;

  test('parses an edit block', () => {
    const e = parseEdits(block('a.py', 'x = 1', 'x = 2'));
    assert.equal(e.length, 1);
    assert.deepEqual(e[0], { path: 'a.py', search: 'x = 1', replace: 'x = 2' });
  });

  test('applies a matching edit and backs up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-ed-'));
    await writeFiles(root, [{ path: 'a.py', contents: 'x = 1\ny = 2\n' }], { mode: 'overwrite', backupDir: join(root, 'b') });
    const backupDir = join(runDir(root), 'backup');
    const { artifacts, failures } = await applyEdits(root, parseEdits(block('a.py', 'x = 1', 'x = 42')), { mode: 'backup', backupDir });
    assert.equal(failures.length, 0);
    assert.equal(artifacts[0]!.status, 'updated');
    assert.equal(readFileSync(join(root, 'a.py'), 'utf8'), 'x = 42\ny = 2\n');
    assert.equal(readFileSync(join(backupDir, 'a.py'), 'utf8'), 'x = 1\ny = 2\n');
  });

  test('reports a non-matching SEARCH instead of corrupting the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-ed2-'));
    await writeFiles(root, [{ path: 'a.py', contents: 'hello\n' }], { mode: 'overwrite', backupDir: join(root, 'b') });
    const { artifacts, failures } = await applyEdits(root, parseEdits(block('a.py', 'not there', 'x')), { mode: 'overwrite', backupDir: join(root, 'b') });
    assert.equal(artifacts.length, 0);
    assert.match(failures[0]!, /did not match/);
    assert.equal(readFileSync(join(root, 'a.py'), 'utf8'), 'hello\n');
  });

  test('fails a non-unique SEARCH rather than guessing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-ed3-'));
    await writeFiles(root, [{ path: 'a.py', contents: 'a\na\n' }], { mode: 'overwrite', backupDir: join(root, 'b') });
    const { failures } = await applyEdits(root, parseEdits(block('a.py', 'a', 'b')), { mode: 'overwrite', backupDir: join(root, 'b') });
    assert.match(failures[0]!, /more than once/);
  });

  test('will not edit a missing file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-ed4-'));
    const { failures } = await applyEdits(root, parseEdits(block('nope.py', 'a', 'b')), { mode: 'overwrite', backupDir: join(root, 'b') });
    assert.match(failures[0]!, /does not exist/);
  });
});
