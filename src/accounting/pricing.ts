import type { Usage } from '../types/ir.ts';

/**
 * Prices in USD per million tokens.
 *
 * These are defaults, not gospel. Vendor pricing changes and the table WILL go
 * stale — that is why `orchestrator.pricing` overrides it from settings and why
 * `CostRecord.usdReported` distinguishes provider-reported cost from cost we
 * derived here. Verify against current vendor pricing before trusting any
 * report that leans on derived numbers.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cache reads are typically a fraction of input. Multiplier, not a rate. */
  cacheReadMultiplier: number;
  /** Cache writes typically cost slightly more than input. */
  cacheWriteMultiplier: number;
}

const DEFAULT_CACHE_READ = 0.1;
const DEFAULT_CACHE_WRITE = 1.25;

function price(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cacheReadMultiplier: DEFAULT_CACHE_READ,
    cacheWriteMultiplier: DEFAULT_CACHE_WRITE,
  };
}

/** Keyed by model id. Aliases resolve through `PRICE_ALIASES`. */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-opus-4-8': price(5, 25),
  'claude-sonnet-5': price(3, 15),
  'claude-haiku-4-5': price(1, 5),
  'gpt-5': price(1.25, 10),
  'gpt-5-mini': price(0.25, 2),
  'gemini-2.5-pro': price(1.25, 10),
  'gemini-2.5-flash': price(0.3, 2.5),
  // Internal model. Cost is infrastructure, not per-token billing, but we still
  // meter it so planning overhead appears in the report instead of hiding.
  gauss: price(0, 0),
});

const PRICE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  flash: 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
});

export class PriceTable {
  private readonly prices: Record<string, ModelPrice>;

  constructor(overrides: Record<string, Partial<ModelPrice>> = {}) {
    this.prices = { ...DEFAULT_PRICES };
    for (const [model, override] of Object.entries(overrides)) {
      const base = this.prices[model] ?? price(0, 0);
      this.prices[model] = { ...base, ...override };
    }
  }

  /** Returns undefined for unknown models so callers can flag, not guess. */
  lookup(model: string): ModelPrice | undefined {
    const canonical = PRICE_ALIASES[model] ?? model;
    if (this.prices[canonical]) {
      return this.prices[canonical];
    }
    // Providers append dated suffixes (`claude-haiku-4-5-20251001`). Fall back
    // to the longest registered id that prefixes the requested one.
    const match = Object.keys(this.prices)
      .filter((id) => canonical.startsWith(id))
      .sort((a, b) => b.length - a.length)[0];
    return match ? this.prices[match] : undefined;
  }

  /**
   * Derives cost from usage. Only used when the provider did not report cost
   * itself; prefer the reported figure whenever one is available.
   */
  cost(model: string, usage: Usage): number {
    const p = this.lookup(model);
    if (!p) {
      return 0;
    }
    const perToken = 1 / 1_000_000;
    return (
      usage.inputTokens * p.input * perToken +
      usage.outputTokens * p.output * perToken +
      usage.cachedInputTokens * p.input * p.cacheReadMultiplier * perToken +
      usage.cacheCreationTokens * p.input * p.cacheWriteMultiplier * perToken
    );
  }

  knownModels(): string[] {
    return Object.keys(this.prices);
  }
}
