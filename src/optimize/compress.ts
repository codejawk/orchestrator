/**
 * Deterministic pre-compression.
 *
 * Everything here is free — no model call — and runs on context before it is
 * sent. That makes it the cheapest saving in the system, and also the one with
 * the most obvious failure mode: compression that removes something the model
 * needed produces a worse answer, and a worse answer costs more than the tokens
 * saved.
 *
 * So the transforms are conservative. Nothing here changes program semantics,
 * and anything ambiguous is left alone. Aggressive stripping is available but
 * off by default.
 */

export interface CompressOptions {
  /** Collapse runs of blank lines. Always safe. */
  collapseBlankLines?: boolean;
  /** Truncate very long string and array literals. */
  elideLongLiterals?: boolean;
  /** Remove license headers, which are pure cost and never relevant. */
  stripLicenseHeader?: boolean;
  /**
   * Remove comments. Off by default: comments frequently carry the intent a
   * model needs, and stripping them is how you get a technically shorter prompt
   * and a worse answer.
   */
  stripComments?: boolean;
  /** Cap for a single string literal before it is elided. */
  literalMaxChars?: number;
}

export const SAFE_DEFAULTS: CompressOptions = {
  collapseBlankLines: true,
  elideLongLiterals: true,
  stripLicenseHeader: true,
  stripComments: false,
  literalMaxChars: 200,
};

export interface CompressResult {
  text: string;
  removedChars: number;
  applied: string[];
}

const LICENSE_HEADER =
  /^\s*(?:\/\*[\s\S]{0,4000}?\*\/|(?:\/\/[^\n]*\n){1,40}|(?:#[^\n]*\n){1,40})/;

const LICENSE_MARKER =
  /\b(?:copyright|licen[cs]e|SPDX-License-Identifier|all rights reserved|Apache License|MIT License|GNU General Public)\b/i;

export function compress(source: string, options: CompressOptions = SAFE_DEFAULTS): CompressResult {
  const opts = { ...SAFE_DEFAULTS, ...options };
  const applied: string[] = [];
  const before = source.length;
  let text = source;

  if (opts.stripLicenseHeader) {
    const match = text.match(LICENSE_HEADER);
    // Only strip if it actually looks like a license, not just any leading comment.
    if (match?.[0] && LICENSE_MARKER.test(match[0])) {
      text = text.slice(match[0].length);
      applied.push('license-header');
    }
  }

  if (opts.stripComments) {
    const stripped = stripCommentsPreservingStrings(text);
    if (stripped !== text) {
      text = stripped;
      applied.push('comments');
    }
  }

  if (opts.elideLongLiterals) {
    const elided = elideLiterals(text, opts.literalMaxChars ?? 200);
    if (elided !== text) {
      text = elided;
      applied.push('long-literals');
    }
  }

  if (opts.collapseBlankLines) {
    const collapsed = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
    if (collapsed !== text) {
      text = collapsed;
      applied.push('blank-lines');
    }
  }

  return { text, removedChars: before - text.length, applied };
}

/**
 * Elides the middle of long literals, keeping both ends.
 *
 * Both ends matter: the head shows what kind of data it is, the tail shows how
 * it terminates. A base64 blob or a 4000-character SQL string tells the model
 * nothing extra after the first line.
 */
function elideLiterals(source: string, maxChars: number): string {
  return source.replace(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g, (match, quote: string, body: string) => {
    if (body.length <= maxChars) {
      return match;
    }
    const keep = Math.floor(maxChars / 2);
    return `${quote}${body.slice(0, keep)}… [${body.length - maxChars} chars elided] …${body.slice(-keep)}${quote}`;
  });
}

/**
 * Comment removal that does not corrupt strings.
 *
 * A naive `//.*` regex mangles URLs inside string literals, which turns working
 * code into code the model then "fixes". This walks the text tracking whether
 * it is inside a string.
 */
export function stripCommentsPreservingStrings(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | undefined;

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];

    if (quote) {
      out += char;
      if (char === '\\') {
        out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      i++;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    out += char;
    i++;
  }

  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * Drops context blocks that appear more than once.
 *
 * Subtasks in one plan often share files, and the ledger can reintroduce a
 * snippet a prior subtask already emitted. Paying twice for identical bytes in
 * one request is pure waste.
 */
export function dedupeBlocks(blocks: { key: string; text: string }[]): {
  kept: { key: string; text: string }[];
  droppedKeys: string[];
} {
  const seen = new Set<string>();
  const kept: { key: string; text: string }[] = [];
  const droppedKeys: string[] = [];

  for (const block of blocks) {
    const fingerprint = block.text.replace(/\s+/g, ' ').trim();
    if (fingerprint.length > 0 && seen.has(fingerprint)) {
      droppedKeys.push(block.key);
      continue;
    }
    seen.add(fingerprint);
    kept.push(block);
  }

  return { kept, droppedKeys };
}
