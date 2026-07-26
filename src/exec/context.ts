import type { ContextRef } from '../types/ir.ts';
import { compress, dedupeBlocks, SAFE_DEFAULTS, type CompressOptions } from '../optimize/compress.ts';
import { skeletonFromText, sliceRange } from '../optimize/skeleton.ts';
import { estimateFileTokens } from '../optimize/tokens.ts';

/**
 * Turns context references into the text a model actually receives.
 *
 * Everything an executing model sees passes through here, which makes it the
 * enforcement point for two guarantees: content is compressed before it is
 * charged for, and nothing appears that was not in the approved reference list.
 */

/** Injected so this is testable without a workspace. */
export type FileReader = (path: string) => Promise<string | undefined>;

export interface MaterializeOptions {
  compression?: CompressOptions;
  /** Hard ceiling. Refs past it are dropped and reported, never silently cut. */
  budgetTokens?: number;
}

export interface MaterializeResult {
  text: string;
  tokens: number;
  included: string[];
  dropped: { path: string; reason: string }[];
  /** Tokens saved by skeletonizing, slicing and compressing, versus full files. */
  savedVersusFull: number;
}

export async function materializeContext(
  refs: ContextRef[],
  read: FileReader,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const compression = options.compression ?? SAFE_DEFAULTS;
  const budget = options.budgetTokens ?? Number.POSITIVE_INFINITY;

  const blocks: { key: string; text: string }[] = [];
  const included: string[] = [];
  const dropped: MaterializeResult['dropped'] = [];
  let tokens = 0;
  let fullTokens = 0;

  for (const ref of refs) {
    const content = await read(ref.path);
    if (content === undefined) {
      dropped.push({ path: ref.path, reason: 'file could not be read' });
      continue;
    }

    fullTokens += estimateFileTokens(ref.path, content);

    const rendered = render(ref, content, compression);
    const cost = estimateFileTokens(ref.path, rendered);

    if (tokens + cost > budget) {
      dropped.push({ path: ref.path, reason: `context budget of ${budget} tokens reached` });
      continue;
    }

    blocks.push({ key: ref.path, text: rendered });
    included.push(ref.path);
    tokens += cost;
  }

  // The same file can be selected by two subtasks or reappear via the ledger.
  // Paying twice for identical bytes in one request is pure waste.
  const { kept, droppedKeys } = dedupeBlocks(blocks);
  for (const key of droppedKeys) {
    dropped.push({ path: key, reason: 'duplicate of content already included' });
  }

  const text = kept.map((block) => block.text).join('\n\n');
  return {
    text,
    tokens,
    included,
    dropped,
    savedVersusFull: Math.max(0, fullTokens - tokens),
  };
}

function render(ref: ContextRef, content: string, compression: CompressOptions): string {
  if (ref.mode === 'skeleton') {
    return `<file path="${ref.path}" mode="skeleton">\n${skeletonFromText(ref.path, content)}\n</file>`;
  }

  if (ref.mode === 'range' && ref.range) {
    const slice = sliceRange(content, ref.range);
    return `<file path="${ref.path}" mode="range" lines="${ref.range[0]}-${ref.range[1]}">\n${slice}\n</file>`;
  }

  const compressed = compress(content, compression);
  const note = compressed.applied.length > 0 ? ` compressed="${compressed.applied.join(',')}"` : '';

  // Hard safety cap. A file explicitly requested past the size limit could be
  // multiple megabytes — sending it whole would blow the model's context. Keep
  // the head (structure, imports, what the file is) and the tail, eliding the
  // middle. For "explain what this file does" the head is what matters.
  const MAX_FULL_CHARS = 120_000;
  if (compressed.text.length > MAX_FULL_CHARS) {
    const keep = Math.floor(MAX_FULL_CHARS / 2);
    const elided = compressed.text.length - MAX_FULL_CHARS;
    const body = `${compressed.text.slice(0, keep)}\n\n… [${elided.toLocaleString()} characters elided — file too large to send whole] …\n\n${compressed.text.slice(-keep)}`;
    return `<file path="${ref.path}" mode="full" truncated="true"${note}>\n${body}\n</file>`;
  }

  return `<file path="${ref.path}" mode="full"${note}>\n${compressed.text}\n</file>`;
}
