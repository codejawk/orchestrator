import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A lightweight listing of the files in the workspace, so the main model knows
 * what already exists and can plan subtasks that read/understand/modify real
 * files (not just generate new ones).
 *
 * This is not a full .gitignore parser — it uses a sensible skip list — but it
 * keeps the listing small and relevant, and never reads file *contents* (the
 * worker models read those on demand).
 */

export interface WorkspaceFile {
  path: string;
  size: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.orchestrator', 'dist', 'build', 'out', '.next', '.turbo',
  'coverage', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', 'target',
  '.idea', '.vscode', '.cache', 'vendor', '.gradle', 'bin', 'obj',
]);

const SKIP_EXT = new Set([
  'lock', 'log', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'pdf', 'zip', 'gz', 'tar',
  'mp4', 'mov', 'mp3', 'woff', 'woff2', 'ttf', 'eot', 'class', 'o', 'a', 'so', 'dylib',
  'exe', 'bin', 'wasm', 'map', 'min.js',
]);

export function listWorkspaceFiles(
  root: string,
  opts: { maxFiles?: number; maxFileSize?: number } = {},
): WorkspaceFile[] {
  const maxFiles = opts.maxFiles ?? 300;
  const maxFileSize = opts.maxFileSize ?? 1_000_000;
  const files: WorkspaceFile[] = [];

  const walk = (dir: string): void => {
    if (files.length >= maxFiles) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        // Skip dotfiles/dirs except a couple of harmless ones; keeps noise down.
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
          // still descend into non-skip dot dirs? No — skip all dot dirs.
        }
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(full);
        }
        continue;
      }
      const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
      if (SKIP_EXT.has(ext)) {
        continue;
      }
      try {
        const st = statSync(full);
        if (st.size > maxFileSize) {
          continue;
        }
        files.push({ path: relative(root, full), size: st.size });
      } catch {
        // unreadable — skip
      }
    }
  };

  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** A compact tree-ish text listing for the decomposition prompt. */
export function fileListForPrompt(files: WorkspaceFile[], limit = 200): string {
  if (files.length === 0) {
    return '(the workspace is empty)';
  }
  const shown = files.slice(0, limit).map((f) => `- ${f.path} (${f.size} B)`);
  if (files.length > limit) {
    shown.push(`… and ${files.length - limit} more files`);
  }
  return shown.join('\n');
}
