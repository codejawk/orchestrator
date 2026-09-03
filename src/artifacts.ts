import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Plan, SubtaskResult, WriteMode, WrittenArtifact } from './types.ts';

/**
 * File handling for the orchestrator.
 *
 * Workers declare the files they produce with explicit markers:
 *
 *   ===FILE: relative/path.py===
 *   <contents>
 *   ===END FILE===
 *
 * so we never have to guess a filename from prose or markdown fences (which
 * produced junk files like `0.0045s` and shattered nested code blocks). Files
 * are written into the working directory at the declared path; logs go into a
 * `.orchestrator/<timestamp>/` folder.
 */

export interface ParsedFile {
  path: string;
  contents: string;
}

const FILE_BLOCK = /===\s*FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n===\s*END FILE\s*===/g;

/** Extract declared files from a worker's output. */
export function parseFiles(text: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let m: RegExpExecArray | null;
  FILE_BLOCK.lastIndex = 0;
  while ((m = FILE_BLOCK.exec(text))) {
    const path = (m[1] ?? '').trim();
    let body = m[2] ?? '';
    // Tolerate a worker that wrapped the body in a ```lang fence.
    body = stripOuterFence(body);
    if (path) {
      files.push({ path, contents: body.replace(/\s+$/, '') + '\n' });
    }
  }
  return files;
}

function stripOuterFence(body: string): string {
  const trimmed = body.replace(/^\s+/, '').replace(/\s+$/, '');
  const fence = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fence ? fence[1]! : body;
}

export interface ParsedEdit {
  path: string;
  search: string;
  replace: string;
}

const EDIT_BLOCK =
  /===\s*EDIT:\s*(.+?)\s*===\r?\n<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE\r?\n===\s*END EDIT\s*===/g;

/** Parse search/replace edit blocks a worker emitted for existing files. */
export function parseEdits(text: string): ParsedEdit[] {
  const edits: ParsedEdit[] = [];
  let m: RegExpExecArray | null;
  EDIT_BLOCK.lastIndex = 0;
  while ((m = EDIT_BLOCK.exec(text))) {
    const path = (m[1] ?? '').trim();
    if (path) {
      edits.push({ path, search: m[2] ?? '', replace: m[3] ?? '' });
    }
  }
  return edits;
}

/**
 * Applies search/replace edits to existing files — the token-efficient way to
 * modify code (only the changed lines are produced, not the whole file). The
 * SEARCH text must match the file exactly (the worker read the file first); a
 * non-match is reported, never force-applied. Files are backed up first.
 */
export async function applyEdits(
  workspaceRoot: string,
  edits: ParsedEdit[],
  opts: WriteOptions,
): Promise<{ artifacts: WrittenArtifact[]; failures: string[] }> {
  const artifacts: WrittenArtifact[] = [];
  const failures: string[] = [];
  // Group edits by file so each file is read/backed-up/written once.
  const byPath = new Map<string, ParsedEdit[]>();
  for (const e of edits) {
    (byPath.get(e.path) ?? byPath.set(e.path, []).get(e.path)!).push(e);
  }

  for (const [rawPath, fileEdits] of byPath) {
    const rel = safeRelative(rawPath);
    if (!rel) {
      failures.push(`unsafe path ${rawPath}`);
      continue;
    }
    const target = join(workspaceRoot, rel);
    const original = await readIfExists(target);
    if (original === null) {
      failures.push(`${rel}: file does not exist (cannot edit a missing file)`);
      continue;
    }

    let content = original;
    let applied = 0;
    for (const e of fileEdits) {
      const idx = content.indexOf(e.search);
      if (e.search === '' || idx === -1) {
        failures.push(`${rel}: an edit's SEARCH block did not match the file`);
        continue;
      }
      if (content.indexOf(e.search, idx + 1) !== -1) {
        failures.push(`${rel}: an edit's SEARCH block matched more than once (make it more specific)`);
        continue;
      }
      content = content.slice(0, idx) + e.replace + content.slice(idx + e.search.length);
      applied++;
    }

    if (applied === 0 || content === original) {
      continue;
    }
    if (opts.mode === 'backup') {
      const backup = join(opts.backupDir, rel);
      await mkdir(dirname(backup), { recursive: true });
      await copyFile(target, backup);
    }
    await writeText(target, content);
    artifacts.push({ label: rel, path: target, status: 'updated' });
    opts.onFile?.(`edited ${rel} (${applied} change${applied === 1 ? '' : 's'}${opts.mode === 'backup' ? ', backup saved' : ''})`, target);
  }
  return { artifacts, failures };
}

export interface WriteOptions {
  /** How to treat an existing file whose content would change. */
  mode: WriteMode;
  /** Where to save backups of overwritten files (for mode 'backup'). */
  backupDir: string;
  onFile?: (line: string, path: string) => void;
}

/**
 * Writes declared files into the working directory, safely.
 *
 * Paths are sanitised so a worker cannot escape the workspace. An existing file
 * is never silently clobbered: identical content is left untouched; a changed
 * file is backed up before overwrite (mode 'backup', the default), left alone
 * with the new version saved as `<name>.orchestrator-new` (mode 'skip'), or
 * plainly overwritten (mode 'overwrite').
 */
export async function writeFiles(
  workspaceRoot: string,
  files: ParsedFile[],
  opts: WriteOptions,
): Promise<WrittenArtifact[]> {
  const artifacts: WrittenArtifact[] = [];
  for (const file of files) {
    const rel = safeRelative(file.path);
    if (!rel) {
      opts.onFile?.(`skipped unsafe path ${file.path}`, file.path);
      continue;
    }
    const target = join(workspaceRoot, rel);
    const prior = await readIfExists(target);

    if (prior === null) {
      await writeText(target, file.contents);
      artifacts.push({ label: rel, path: target, status: 'created' });
      opts.onFile?.(`created ${rel}`, target);
      continue;
    }
    if (prior === file.contents) {
      artifacts.push({ label: rel, path: target, status: 'unchanged' });
      opts.onFile?.(`unchanged ${rel}`, target);
      continue;
    }
    // Existing file would change.
    if (opts.mode === 'skip') {
      const alt = `${target}.orchestrator-new`;
      await writeText(alt, file.contents);
      artifacts.push({ label: `${rel}.orchestrator-new`, path: alt, status: 'kept-existing' });
      opts.onFile?.(`kept existing ${rel}; new version at ${rel}.orchestrator-new`, alt);
      continue;
    }
    if (opts.mode === 'backup') {
      const backup = join(opts.backupDir, rel);
      await mkdir(dirname(backup), { recursive: true });
      await copyFile(target, backup);
    }
    await writeText(target, file.contents);
    artifacts.push({ label: rel, path: target, status: 'updated' });
    opts.onFile?.(`updated ${rel}${opts.mode === 'backup' ? ' (backup saved)' : ''}`, target);
  }
  return artifacts;
}

async function writeText(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Writes plan, raw transcripts and the final report into the given log dir. */
export async function writeLogs(
  logRoot: string,
  plan: Plan,
  results: SubtaskResult[],
  report: string,
): Promise<string> {
  await mkdir(join(logRoot, 'raw'), { recursive: true });
  await writeFile(join(logRoot, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  await writeFile(join(logRoot, 'report.md'), report, 'utf8');
  for (const r of results) {
    await writeFile(join(logRoot, 'raw', `${safeName(r.id)}.md`), r.text || r.error || '', 'utf8');
  }
  return logRoot;
}

/** A run directory under `.orchestrator/<timestamp>/` for logs and backups. */
export function runDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.orchestrator', timestamp());
}

/** A workspace-relative path that cannot escape the root, or undefined. */
function safeRelative(input: string): string | undefined {
  let p = input.replace(/\\/g, '/').replace(/^~\//, '').trim();
  if (isAbsolute(p)) {
    p = p.replace(/^\/+/, '');
  }
  const norm = normalize(p);
  if (!norm || norm.startsWith('..') || norm.split(sep).includes('..')) {
    return undefined;
  }
  return norm;
}

function safeName(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '') || 'artifact';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
