import * as vscode from 'vscode';
import type { CandidateFile } from './planner/contextSelector.ts';
import type { ScanInput } from './planner/scanner.ts';
import { skeletonFromSymbols, skeletonFromText, type SymbolNode } from './optimize/skeleton.ts';
import { estimateFileTokens, estimateTokens } from './optimize/tokens.ts';
import type { FileReader } from './exec/context.ts';

/**
 * Everything that touches the workspace.
 *
 * Isolated here so the planner stays free of vscode imports — it is the module
 * the isolation test guards, and it needs to be runnable in the eval harness
 * outside an extension host.
 */

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.gradle/**',
  '**/vendor/**',
  '**/*.min.js',
  '**/*.map',
  '**/package-lock.json',
  '**/*.{png,jpg,jpeg,gif,ico,pdf,zip,tar,gz,bz2,xz,jar,apk,so,a,o,bin,img,dtb,elf,exe,dll,dylib,woff,woff2,ttf}',
].join(',');

/** Bigger than this and a file is almost certainly generated or binary. */
/** Default ceiling on a single file. Overridable via orchestrator.scan.maxFileBytes. */
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface WorkspaceFile {
  path: string;
  uri: vscode.Uri;
  content: string;
  bytes: number;
}

export interface CollectResult {
  files: WorkspaceFile[];
  skipped: { path: string; reason: string }[];
}

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

/**
 * Reads a folder for scanning.
 *
 * Binary detection is a NUL-byte check rather than an extension list, because
 * platform trees are full of extensionless binaries and `.bin` files that are
 * actually text.
 */
export async function collectFiles(
  folder?: vscode.Uri,
  maxFiles = 2_000,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
  token?: vscode.CancellationToken,
): Promise<CollectResult> {
  const root = folder ?? workspaceRoot();
  if (!root) {
    return { files: [], skipped: [] };
  }

  const pattern = new vscode.RelativePattern(root, '**/*');
  const uris = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, maxFiles, token);

  const files: WorkspaceFile[] = [];
  const skipped: CollectResult['skipped'] = [];

  for (const uri of uris) {
    if (token?.isCancellationRequested) {
      break;
    }
    const path = relativePath(uri);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxBytes) {
        // Named so the message can tell the user what to raise, and by how much:
        // a huge generated/data file is exactly the thing you would not want fed
        // to a model whole, but the user should still know it was skipped.
        skipped.push({
          path,
          reason: `${(stat.size / 1024 / 1024).toFixed(1)}MB, over the ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit (orchestrator.scan.maxFileBytes)`,
        });
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) {
        skipped.push({ path, reason: 'binary' });
        continue;
      }
      files.push({ path, uri, content: new TextDecoder().decode(bytes), bytes: stat.size });
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : 'unreadable' });
    }
  }

  return { files, skipped };
}

export function toScanInputs(files: WorkspaceFile[]): ScanInput[] {
  return files.map((file) => ({ path: file.path, content: file.content }));
}

/**
 * Builds selection candidates.
 *
 * Skeletons come from the language server when one is available, which costs no
 * model tokens and is accurate. Platform trees contain plenty of files no
 * language server handles — device trees, makefiles, vendor assembly — so the
 * regex fallback is the common path, not the exception.
 */
export async function buildCandidates(
  files: WorkspaceFile[],
  externalAllowed: (path: string) => boolean,
  token?: vscode.CancellationToken,
): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];

  for (const file of files) {
    if (token?.isCancellationRequested) {
      break;
    }
    const skeleton = await buildSkeleton(file);
    candidates.push({
      path: file.path,
      skeleton,
      fullTokens: estimateFileTokens(file.path, file.content),
      skeletonTokens: estimateTokens(skeleton, 'code'),
      externalAllowed: externalAllowed(file.path),
    });
  }

  return candidates;
}

async function buildSkeleton(file: WorkspaceFile): Promise<string> {
  const lineCount = file.content.split('\n').length;
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      file.uri,
    );
    if (symbols && symbols.length > 0) {
      return skeletonFromSymbols(file.path, symbols.map(toSymbolNode), lineCount);
    }
  } catch {
    // No provider, or the file is not open in a supported language. Fall back.
  }
  return skeletonFromText(file.path, file.content);
}

function toSymbolNode(symbol: vscode.DocumentSymbol): SymbolNode {
  return {
    name: symbol.name,
    kind: vscode.SymbolKind[symbol.kind]?.toLowerCase() ?? 'unknown',
    line: symbol.selectionRange.start.line + 1,
    ...(symbol.detail ? { detail: symbol.detail } : {}),
    ...(symbol.children?.length ? { children: symbol.children.map(toSymbolNode) } : {}),
  };
}

/** File reader for the executor, scoped to the workspace root. */
export function createFileReader(): FileReader {
  return async (path: string) => {
    const root = workspaceRoot();
    if (!root) {
      return undefined;
    }
    try {
      const uri = vscode.Uri.joinPath(root, path);
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(bytes);
    } catch {
      return undefined;
    }
  };
}

/**
 * Applies a search/replace edit through the workspace edit API, so it lands in
 * VS Code's undo stack and the user can revert it like any other change.
 */
export async function applyEdit(
  path: string,
  search: string,
  replace: string,
): Promise<{ ok: boolean; reason?: string }> {
  const root = workspaceRoot();
  if (!root) {
    return { ok: false, reason: 'no workspace folder open' };
  }

  const uri = vscode.Uri.joinPath(root, path);

  // New-file creation: an edit with an empty `search` means "create this file
  // (or replace it whole) with `replace`". This is how a from-scratch task —
  // "write a C++ file that solves X" — lands its output on disk.
  if (search === '') {
    const exists = await fileExists(uri);
    const edit = new vscode.WorkspaceEdit();
    if (!exists) {
      edit.createFile(uri, { contents: new TextEncoder().encode(replace), ignoreIfExists: false });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), replace);
    }
    const created = await vscode.workspace.applyEdit(edit);
    if (created && !exists) {
      // Open the new file so the user sees the result.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }
    return created ? { ok: true } : { ok: false, reason: 'workspace rejected the file creation' };
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { ok: false, reason: `could not open ${path}` };
  }

  const text = document.getText();
  const first = text.indexOf(search);
  if (first === -1) {
    return { ok: false, reason: 'search text not found — the file may have changed' };
  }
  if (text.indexOf(search, first + 1) !== -1) {
    // Ambiguous match: applying to the first occurrence would be a guess, and a
    // wrong guess silently corrupts code.
    return { ok: false, reason: 'search text appears more than once — refusing to guess' };
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(first), document.positionAt(first + search.length)),
    replace,
  );
  const applied = await vscode.workspace.applyEdit(edit);
  return applied ? { ok: true } : { ok: false, reason: 'workspace rejected the edit' };
}

/** Shows a proposed edit as a diff rather than applying it silently. */
export async function previewEdit(path: string, search: string, replace: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const uri = vscode.Uri.joinPath(root, path);

  // New file (empty search): there is nothing to diff against, so just show the
  // proposed content in a scratch buffer for review.
  if (search === '' && !(await fileExists(uri))) {
    const scratch = await vscode.workspace.openTextDocument({
      content: replace,
      language: languageFromPath(path),
    });
    await vscode.window.showTextDocument(scratch, { preview: true });
    return;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const proposed = search === '' ? replace : document.getText().replace(search, replace);
  const scratch = await vscode.workspace.openTextDocument({
    content: proposed,
    language: document.languageId,
  });
  await vscode.commands.executeCommand('vscode.diff', uri, scratch.uri, `${path} — proposed`);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort VS Code language id from a file extension, for scratch buffers. */
function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'cpp',
    c: 'c', ts: 'typescript', js: 'javascript', py: 'python', java: 'java',
    go: 'go', rs: 'rust', rb: 'ruby', cs: 'csharp', md: 'markdown', json: 'json',
  };
  return map[ext] ?? 'plaintext';
}
