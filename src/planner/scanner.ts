import { createHash } from 'node:crypto';
import type { ClassificationReason, CostRecord, Tier } from '../types/ir.ts';
import { TIER_RANK } from '../types/ir.ts';
import { estimateFileTokens, estimateTokens } from '../optimize/tokens.ts';
import { prefilter, type PatternRule } from '../policy/patterns.ts';
import type { Planner } from './gauss.ts';

/**
 * The sensitivity scan.
 *
 * Gauss is a plain LLM, so this module does all the agentic work in TypeScript:
 * it walks the file list, decides what is worth asking about, batches the
 * questions, and validates the answers. Gauss is only ever handed text and
 * asked for a judgement.
 *
 * Two-stage by design:
 *
 *   1. `prefilter` runs regexes over the FULL content of every file. Free,
 *      instant, and deterministic — a private key is caught every time.
 *   2. Whatever the regexes did not decide gets a *digest* sent to Gauss for
 *      semantic judgement: unreleased plans, architecture that is sensitive by
 *      context rather than by token.
 *
 * The digest is a real limitation and worth stating plainly: Gauss sees a
 * sample of each file, not all of it, because scanning a large repo in full
 * would cost more than the work being planned. Secrets are unaffected — those
 * are caught in stage 1 against complete content. What a digest can miss is a
 * single sensitive paragraph buried in the middle of a long file that is
 * otherwise unremarkable. `orchestrator.scan.digestTokens` raises the sample
 * size for teams that would rather pay than accept that gap.
 */

export interface ScanInput {
  path: string;
  content: string;
}

export type VerdictSource = 'prefilter' | 'gauss' | 'cached' | 'unscanned';

export interface FileVerdict {
  path: string;
  contentHash: string;
  tier: Tier;
  reasons: ClassificationReason[];
  source: VerdictSource;
  /** One line from Gauss explaining the call, shown in the review panel. */
  summary?: string;
  estTokens: number;
}

export interface ScanReport {
  scannedAt: string;
  files: FileVerdict[];
  /** Files excluded before scanning: binary, too large, ignored. */
  skipped: { path: string; reason: string }[];
  costs: CostRecord[];
  warnings: string[];
}

export interface ScanOptions {
  rules?: readonly PatternRule[];
  /** Token budget for each file's digest. */
  digestTokens?: number;
  /** Files per Gauss call. Larger batches amortize the prompt overhead. */
  batchSize?: number;
  /** Previously computed verdicts, keyed by content hash. */
  cache?: Map<string, FileVerdict>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const DEFAULT_DIGEST_TOKENS = 400;
const DEFAULT_BATCH_SIZE = 12;

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/** Lines worth showing Gauss even when they fall outside the head and tail. */
const INTERESTING_LINE =
  /\b(?:confidential|internal|proprietary|unreleased|roadmap|secret|credential|token|licen[cs]e|patent|customer|partner|codename|do not|nda)\b/i;

/**
 * Builds the sample of a file that Gauss judges.
 *
 * Head and tail carry headers, licence blocks and trailing notes. The middle is
 * sampled by relevance rather than position, because a confidentiality notice
 * is rarely on line 1 of a long document.
 */
export function buildDigest(
  path: string,
  content: string,
  budgetTokens: number = DEFAULT_DIGEST_TOKENS,
): string {
  const lines = content.split('\n');
  const budgetChars = budgetTokens * 3.5;

  if (content.length <= budgetChars) {
    return `<file path="${path}" complete="true">\n${content}\n</file>`;
  }

  // Relevance-matched lines are claimed FIRST, before head and tail get any
  // budget. Filling head-first looks natural and is wrong: on a long file the
  // head alone exhausts the budget, and the one line that actually decides the
  // classification — "SAMSUNG CONFIDENTIAL" on line 300 — never gets sent.
  const notable: string[] = [];
  for (let i = 0; i < lines.length && notable.length < MAX_NOTABLE_LINES; i++) {
    const line = lines[i] ?? '';
    if (INTERESTING_LINE.test(line)) {
      notable.push(`${i + 1}: ${line.trim().slice(0, 200)}`);
    }
  }

  const remaining = Math.max(0, budgetChars - joinLength(notable));
  const head = takeUnderBudget(lines, remaining * 0.75, 'start');
  const tail = takeUnderBudget(lines.slice(head.length), remaining * 0.25, 'end');

  return [
    `<file path="${path}" complete="false" lines="${lines.length}">`,
    head.join('\n'),
    notable.length > 0 ? `\n… ${notable.length} notable line${notable.length === 1 ? '' : 's'} from the body …\n${notable.join('\n')}` : '',
    tail.length > 0 ? `\n… end of file …\n${tail.join('\n')}` : '',
    '</file>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Cap on relevance-matched lines, so one noisy file cannot eat a whole batch. */
const MAX_NOTABLE_LINES = 20;

function joinLength(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

function takeUnderBudget(lines: string[], budgetChars: number, from: 'start' | 'end'): string[] {
  const source = from === 'start' ? lines : [...lines].reverse();
  const taken: string[] = [];
  let used = 0;

  for (const line of source) {
    if (used + line.length + 1 > budgetChars) {
      break;
    }
    taken.push(line);
    used += line.length + 1;
  }

  return from === 'start' ? taken : taken.reverse();
}

const SCAN_SYSTEM = `You classify source files for a Samsung engineering team deciding what may be sent to external AI providers (Anthropic, OpenAI, Google).

Assign exactly one tier per file:
- "public": open-source, generic boilerplate, public documentation.
- "internal": ordinary company code with no specific secret. Safe to share externally under an enterprise agreement.
- "confidential": unreleased product detail, roadmap, partner or customer specifics, internal architecture that reveals strategy.
- "restricted": bootloader, secure boot, TEE/TrustZone/Knox, cryptographic key handling, attestation, or any credential material. Never leaves the company.

You see a sample of each file, not always the whole thing. Judge on what you see and say so if unsure. Prefer the higher tier when genuinely uncertain, but do not mark ordinary application code confidential just because it belongs to the company — over-classifying everything makes the control useless.

Give a "reason" of at most 15 words, written for an engineer deciding whether to approve.`;

const SCAN_SCHEMA = {
  name: 'file_classification',
  schema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            tier: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] },
            reason: { type: 'string' },
            unsure: { type: 'boolean' },
          },
          required: ['path', 'tier', 'reason', 'unsure'],
          additionalProperties: false,
        },
      },
    },
    required: ['files'],
    additionalProperties: false,
  },
} as const;

interface GaussFileVerdict {
  path: string;
  tier: Tier;
  reason: string;
  unsure: boolean;
}

export async function scanFiles(
  inputs: ScanInput[],
  gauss: Planner,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const rules = options.rules;
  const cache = options.cache ?? new Map<string, FileVerdict>();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const digestTokens = options.digestTokens ?? DEFAULT_DIGEST_TOKENS;

  const files: FileVerdict[] = [];
  const skipped: ScanReport['skipped'] = [];
  const warnings: string[] = [];
  const costs: CostRecord[] = [];
  const needsGauss: { input: ScanInput; hash: string }[] = [];

  for (const input of inputs) {
    const hash = hashContent(input.content);
    const cached = cache.get(hash);
    if (cached) {
      files.push({ ...cached, path: input.path, source: 'cached' });
      continue;
    }

    const pre = prefilter(input.path, input.content, rules);
    const estTokens = estimateFileTokens(input.path, input.content);

    // A restricted verdict from the prefilter is final. Nothing Gauss could say
    // would make a private key safe to send, so we do not pay to ask.
    if (pre.decided && pre.tier === 'restricted') {
      const verdict: FileVerdict = {
        path: input.path,
        contentHash: hash,
        tier: pre.tier,
        reasons: pre.reasons,
        source: 'prefilter',
        estTokens,
      };
      files.push(verdict);
      cache.set(hash, verdict);
      continue;
    }

    needsGauss.push({ input, hash });
    files.push({
      path: input.path,
      contentHash: hash,
      tier: pre.tier,
      reasons: pre.reasons,
      source: 'unscanned',
      estTokens,
    });
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  let done = 0;

  for (let i = 0; i < needsGauss.length; i += batchSize) {
    if (options.signal?.aborted) {
      warnings.push('Scan cancelled; unscanned files are treated as restricted.');
      break;
    }

    const batch = needsGauss.slice(i, i + batchSize);
    const digests = batch
      .map(({ input }) => buildDigest(input.path, input.content, digestTokens))
      .join('\n\n');

    let result;
    try {
      result = await gauss.complete<{ files: GaussFileVerdict[] }>({
        purpose: 'scan',
        system: SCAN_SYSTEM,
        user: `Classify each file. Return one entry per file, using the exact path given.\n\n${digests}`,
        schema: SCAN_SCHEMA,
        maxTokens: 200 + batch.length * 60,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      warnings.push(
        `Scan batch failed (${error instanceof Error ? error.message : String(error)}). Those files stay unscanned and are treated as restricted.`,
      );
      done += batch.length;
      options.onProgress?.(done, needsGauss.length);
      continue;
    }

    costs.push(result.cost);
    warnings.push(...result.warnings);

    const verdicts = result.data?.files ?? [];
    const seen = new Set<string>();

    for (const verdict of verdicts) {
      const file = byPath.get(verdict.path);
      if (!file) {
        // Model invented or mangled a path. Ignore it rather than trust it.
        continue;
      }
      seen.add(verdict.path);

      // Never let the model downgrade what the prefilter already flagged.
      const modelTier = normalizeTier(verdict.tier);
      const tier =
        TIER_RANK[modelTier] >= TIER_RANK[file.tier] ? modelTier : file.tier;

      file.tier = verdict.unsure && TIER_RANK[tier] < TIER_RANK.confidential
        ? 'confidential'
        : tier;
      file.source = 'gauss';
      file.summary = verdict.reason;
      file.reasons = [
        ...file.reasons,
        {
          signal: 'model',
          detail: verdict.unsure ? `${verdict.reason} (model was unsure)` : verdict.reason,
          path: verdict.path,
        },
      ];
      cache.set(file.contentHash, { ...file });
    }

    for (const { input } of batch) {
      if (!seen.has(input.path)) {
        warnings.push(`Gauss returned no verdict for ${input.path}; treated as restricted.`);
      }
    }

    done += batch.length;
    options.onProgress?.(done, needsGauss.length);
  }

  // Fail closed. Anything the scan could not decide is restricted, which means
  // it stays on Gauss until a human says otherwise.
  for (const file of files) {
    if (file.source === 'unscanned') {
      file.tier = 'restricted';
      file.reasons = [
        ...file.reasons,
        { signal: 'model', detail: 'Not classified; failing closed to restricted', path: file.path },
      ];
    }
  }

  return { scannedAt: new Date().toISOString(), files, skipped, costs, warnings };
}

function normalizeTier(value: string): Tier {
  return value === 'public' || value === 'internal' || value === 'confidential' || value === 'restricted'
    ? value
    : 'restricted';
}

/** Cost of scanning, for the report. Scanning is planning, so it counts. */
export function scanCostSummary(report: ScanReport): { usd: number; calls: number } {
  return {
    usd: report.costs.reduce((sum, record) => sum + record.usd, 0),
    calls: report.costs.length,
  };
}

/** Rough forecast shown before a scan starts, so nobody is surprised. */
export function estimateScanCost(inputs: ScanInput[], digestTokens = DEFAULT_DIGEST_TOKENS): number {
  const undecided = inputs.filter((input) => {
    const pre = prefilter(input.path, input.content);
    return !(pre.decided && pre.tier === 'restricted');
  });
  return undecided.reduce(
    (sum, input) => sum + Math.min(estimateTokens(input.content, 'code'), digestTokens),
    0,
  );
}
