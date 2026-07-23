/**
 * File skeletons: signatures without bodies.
 *
 * The cheapest context there is. A 900-line file becomes 40 lines of
 * declarations, which is usually everything a model needs to *call* into that
 * file — it only needs the body if it is going to change it.
 *
 * Built from the language server's symbol tree where one is available, since
 * that costs nothing and is accurate. The regex fallback exists because Samsung
 * platform work involves plenty of files no TypeScript-flavoured language
 * server will parse — device trees, makefiles, assembly, vendor C.
 */

export interface SymbolNode {
  name: string;
  /** Mirrors vscode.SymbolKind names, lowercased. */
  kind: string;
  /** 1-indexed line where the symbol is declared. */
  line: number;
  detail?: string;
  children?: SymbolNode[];
}

const INTERESTING_KINDS = new Set([
  'class', 'interface', 'enum', 'struct', 'function', 'method', 'constructor',
  'property', 'field', 'constant', 'variable', 'namespace', 'module', 'typeparameter',
]);

/** Members below this depth are elided; nesting past it is rarely load-bearing. */
const MAX_DEPTH = 2;

export function skeletonFromSymbols(path: string, symbols: SymbolNode[], totalLines: number): string {
  const lines: string[] = [`// ${path} — ${totalLines} lines, signatures only`];

  const walk = (nodes: SymbolNode[], depth: number) => {
    for (const node of nodes) {
      if (!INTERESTING_KINDS.has(node.kind.toLowerCase())) {
        continue;
      }
      const indent = '  '.repeat(depth);
      const detail = node.detail ? ` ${node.detail}` : '';
      lines.push(`${indent}${node.kind} ${node.name}${detail}  // :${node.line}`);

      if (node.children?.length && depth < MAX_DEPTH) {
        walk(node.children, depth + 1);
      } else if (node.children?.length) {
        lines.push(`${indent}  … ${node.children.length} members`);
      }
    }
  };

  walk(symbols, 0);

  if (lines.length === 1) {
    lines.push('// (no symbols reported)');
  }
  return lines.join('\n');
}

/**
 * Declaration patterns for files no language server handles. Deliberately
 * broad — a false positive costs one wasted line, a false negative hides an
 * API the model then cannot see.
 */
const DECLARATION_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/,
  /^\s*(?:export\s+)?(?:interface|type|enum|struct|union|trait|impl)\s+\w+/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*[:=]\s*(?:async\s*)?\(/,
  /^\s*(?:public|private|protected|internal|static|final)[\w\s<>,]*\s+\w+\s*\(/,
  /^\s*def\s+\w+/,
  /^\s*(?:pub\s+)?fn\s+\w+/,
  /^\s*func\s+\w+/,
  /^\s*#define\s+\w+/,
  /^\s*(?:extern|static)?\s*[\w*]+\s+\w+\s*\([^;]*\)\s*[;{]/,
  /^\s*[\w-]+\s*:\s*$/,              // yaml keys, device-tree nodes
  /^\s*\w+\s*=\s*<[^>]*>;/,          // device-tree properties
  /^[A-Za-z_][\w.-]*\s*:=?/,         // makefile targets and vars
];

export function skeletonFromText(path: string, content: string, maxLines = 120): string {
  const lines = content.split('\n');
  const kept: string[] = [`// ${path} — ${lines.length} lines, declarations only`];

  for (let i = 0; i < lines.length && kept.length <= maxLines; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0 || line.length > 300) {
      continue;
    }
    if (DECLARATION_PATTERNS.some((pattern) => pattern.test(line))) {
      kept.push(`${line.trimEnd().slice(0, 200)}  // :${i + 1}`);
    }
  }

  if (kept.length === 1) {
    // Nothing matched — show the head rather than an empty skeleton, otherwise
    // the selector is choosing blind.
    kept.push(...lines.slice(0, 20).map((line) => line.slice(0, 200)));
  }
  if (kept.length > maxLines) {
    kept.length = maxLines;
    kept.push(`// … truncated at ${maxLines} lines`);
  }

  return kept.join('\n');
}

/** Extracts the requested line range, 1-indexed and inclusive. */
export function sliceRange(content: string, range: [number, number]): string {
  const lines = content.split('\n');
  const start = Math.max(1, range[0]);
  const end = Math.min(lines.length, range[1]);
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join('\n');
}
