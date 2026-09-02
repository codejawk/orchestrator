import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Plan, SubtaskResult, WrittenArtifact } from './types.ts';

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

/**
 * Writes declared files into the working directory. Paths are sanitised so a
 * worker cannot escape the workspace; each write is reported through `onFile`.
 */
export async function writeFiles(
  workspaceRoot: string,
  files: ParsedFile[],
  onFile?: (line: string, path: string) => void,
): Promise<WrittenArtifact[]> {
  const artifacts: WrittenArtifact[] = [];
  for (const file of files) {
    const rel = safeRelative(file.path);
    if (!rel) {
      onFile?.(`skipped unsafe path ${file.path}`, file.path);
      continue;
    }
    const target = join(workspaceRoot, rel);
    const existed = await exists(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, 'utf8');
    artifacts.push({ label: rel, path: target, kind: 'generated' });
    onFile?.(`${existed ? 'updated' : 'created'} ${rel}`, target);
  }
  return artifacts;
}

/** Writes plan, raw transcripts and the final report into `.orchestrator/`. */
export async function writeLogs(
  workspaceRoot: string,
  plan: Plan,
  results: SubtaskResult[],
  report: string,
): Promise<string> {
  const logRoot = join(workspaceRoot, '.orchestrator', timestamp());
  await mkdir(join(logRoot, 'raw'), { recursive: true });
  await writeFile(join(logRoot, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  await writeFile(join(logRoot, 'report.md'), report, 'utf8');
  for (const r of results) {
    await writeFile(join(logRoot, 'raw', `${safeName(r.id)}.md`), r.text || r.error || '', 'utf8');
  }
  return logRoot;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
