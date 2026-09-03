import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceFile } from './workspace.ts';

/**
 * A lightweight "code map": each file's top-level structure — classes,
 * functions, exports, signatures — WITHOUT bodies. Given to the models so they
 * understand the shape of a codebase without reading every line (far fewer read
 * round-trips and tokens); they open full files only where they need detail.
 *
 * This is heuristic (regex per language), not a language server — good enough to
 * orient a model, and it costs nothing.
 */

// Top-level definitions and (indented) method signatures. Kept deliberately
// tight so the map is real structure, not every local variable or `if`.
const DEF_PATTERNS: Record<string, RegExp[]> = {
  py: [/^\s*(async\s+def|def|class)\s+\w+.*:/],
  ts: [
    /^\s*(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|enum)\s+\w+/,
    /^(export\s+)?(const|let)\s+\w+/, // top-level only (no leading indent)
    /^\s+(public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|get\s+|set\s+)*[a-zA-Z_]\w*\s*\([^)]*\)\s*[:{]/, // method signature
  ],
  js: [
    /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class)\s+\w+/,
    /^(export\s+)?(const|let)\s+\w+\s*=/,
  ],
  go: [/^\s*(func|type)\s+\w+/],
  rs: [/^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod)\s+\w+/],
  java: [/^\s*(public|private|protected)?\s*(static\s+)?(final\s+)?(class|interface|enum|\w[\w<>\[\]]*\s+\w+\s*\()/],
  rb: [/^\s*(def|class|module)\s+\w+/],
  c: [/^\s*[\w*]+\s+\w+\s*\([^;]*\)\s*\{?$/, /^\s*(struct|enum|typedef)\s+\w+/],
};

const CONTROL_KW = /^(if|for|while|switch|catch|return|else|do|try|await|throw|new|yield)\b/;
DEF_PATTERNS.tsx = DEF_PATTERNS.ts!;
DEF_PATTERNS.jsx = DEF_PATTERNS.js!;
DEF_PATTERNS.mjs = DEF_PATTERNS.js!;
DEF_PATTERNS.cpp = DEF_PATTERNS.c!;
DEF_PATTERNS.h = DEF_PATTERNS.c!;
DEF_PATTERNS.hpp = DEF_PATTERNS.c!;

/** Signature-like lines from one file (trimmed, comment-stripped, capped). */
export function fileOutline(path: string, content: string, maxLines = 40): string[] {
  const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  const patterns = DEF_PATTERNS[ext];
  if (!patterns) {
    return [];
  }
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    if (out.length >= maxLines) {
      break;
    }
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || CONTROL_KW.test(trimmed)) {
      continue;
    }
    if (patterns.some((re) => re.test(line))) {
      // Keep the signature only, drop a trailing "{" and long default bodies.
      out.push(line.replace(/\s*\{?\s*$/, '').trim().slice(0, 200));
    }
  }
  return out;
}

/**
 * Builds the code map for the workspace, bounded so it never bloats the prompt.
 * Reads file contents (cheap local I/O) only for code files.
 */
export function workspaceOutline(
  root: string,
  files: WorkspaceFile[],
  opts: { maxFiles?: number; maxChars?: number } = {},
): string {
  const maxFiles = opts.maxFiles ?? 120;
  const maxChars = opts.maxChars ?? 16000;
  const parts: string[] = [];
  let chars = 0;
  let shown = 0;

  for (const file of files) {
    if (shown >= maxFiles || chars >= maxChars) {
      break;
    }
    let content: string;
    try {
      content = readFileSync(join(root, file.path), 'utf8');
    } catch {
      continue;
    }
    const sigs = fileOutline(file.path, content);
    if (sigs.length === 0) {
      continue;
    }
    const block = `${file.path}\n${sigs.map((s) => `  ${s}`).join('\n')}`;
    if (chars + block.length > maxChars) {
      break;
    }
    parts.push(block);
    chars += block.length;
    shown++;
  }

  if (parts.length === 0) {
    return '(no recognizable code structure — open files directly if needed)';
  }
  return parts.join('\n\n');
}
