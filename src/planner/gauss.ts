import { meterOpenAiCompatible, toCostRecord } from '../accounting/meter.ts';
import type { PriceTable } from '../accounting/pricing.ts';
import type { CostRecord } from '../types/ir.ts';

/**
 * The Gauss client. Every planning call in this extension goes through here and
 * nowhere else.
 *
 * Gauss is a plain LLM, not an agent: it has no tools, no file access and no
 * loop. Everything agentic — walking a directory, reading files, batching — is
 * done by this extension in TypeScript, and Gauss is only ever asked to judge
 * or transform text we hand it. That keeps the internal model's job small and
 * well-specified, which matters because we are betting the whole design on it
 * being reliable at these narrow tasks.
 *
 * Because Gauss's exact API surface is not yet pinned down, structured output
 * degrades through three strategies rather than assuming one works.
 */

export type ResponseFormatMode = 'json_schema' | 'json_object' | 'prompt';

export interface GaussOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  prices: PriceTable;
  /** Falls back automatically if the endpoint rejects the richer modes. */
  responseFormat?: ResponseFormatMode;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface GaussRequest {
  /** Short label used to attribute cost in the report: 'scan', 'compile', … */
  purpose: string;
  system?: string;
  user: string;
  /** When present, the reply is parsed and validated against this schema. */
  schema?: { name: string; schema: object };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GaussResult<T = unknown> {
  text: string;
  /** Present when a schema was requested and parsing succeeded. */
  data?: T;
  cost: CostRecord;
  warnings: string[];
}

export class GaussError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'GaussError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

export class GaussClient {
  private format: ResponseFormatMode;
  /** Cost of every call this client has made, for the run accounting. */
  readonly costs: CostRecord[] = [];

  private readonly options: GaussOptions;

  constructor(options: GaussOptions) {
    this.options = options;
    this.format = options.responseFormat ?? 'json_schema';
  }

  get model(): string {
    return this.options.model;
  }

  /** Total spent on planning so far. Surfaced in the report, never hidden. */
  totalUsd(): number {
    return this.costs.reduce((sum, record) => sum + record.usd, 0);
  }

  async complete<T = unknown>(request: GaussRequest): Promise<GaussResult<T>> {
    const warnings: string[] = [];
    const started = Date.now();

    const { body, text } = await this.callWithFormatFallback(request, warnings);

    const meter = meterOpenAiCompatible(body);
    const cost = toCostRecord({
      adapter: 'gauss',
      requestedModel: this.options.model,
      meter,
      durationMs: Date.now() - started,
      prices: this.options.prices,
    });
    this.costs.push(cost);
    warnings.push(...meter.warnings);

    const result: GaussResult<T> = { text, cost, warnings };

    if (request.schema) {
      const parsed = extractJson<T>(text);
      if (parsed.ok) {
        result.data = parsed.value;
      } else {
        // One repair round-trip. If a small internal model cannot produce valid
        // JSON twice, retrying further is throwing money at a broken prompt.
        warnings.push(`${request.purpose}: reply was not valid JSON, attempting repair`);
        const repaired = await this.repair<T>(request, text, parsed.error);
        if (repaired) {
          result.data = repaired.data;
          result.text = repaired.text;
          this.costs.push(repaired.cost);
        } else {
          warnings.push(`${request.purpose}: repair failed, structured output unavailable`);
        }
      }
    }

    return result;
  }

  private async repair<T>(
    original: GaussRequest,
    badReply: string,
    error: string,
  ): Promise<{ data: T; text: string; cost: CostRecord } | undefined> {
    const started = Date.now();
    const schema = original.schema;
    if (!schema) {
      return undefined;
    }
    try {
      const { body, text } = await this.post({
        ...original,
        purpose: `${original.purpose}:repair`,
        system: 'You output only valid JSON matching the given schema. No prose, no code fences.',
        user: [
          'The previous reply did not parse as JSON.',
          `Parser error: ${error}`,
          '',
          'Schema:',
          JSON.stringify(schema.schema),
          '',
          'Previous reply:',
          badReply.slice(0, 4_000),
          '',
          'Return the corrected JSON only.',
        ].join('\n'),
      });
      const parsed = extractJson<T>(text);
      if (!parsed.ok) {
        return undefined;
      }
      const meter = meterOpenAiCompatible(body);
      return {
        data: parsed.value,
        text,
        cost: toCostRecord({
          adapter: 'gauss',
          requestedModel: this.options.model,
          meter,
          durationMs: Date.now() - started,
          prices: this.options.prices,
        }),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Tries the richest structured-output mode the endpoint accepts and remembers
   * the answer, so an endpoint that rejects `json_schema` costs one failed call
   * per session rather than one per request.
   */
  private async callWithFormatFallback(
    request: GaussRequest,
    warnings: string[],
  ): Promise<{ body: unknown; text: string }> {
    const order: ResponseFormatMode[] = ['json_schema', 'json_object', 'prompt'];
    const start = order.indexOf(this.format);

    for (let i = Math.max(start, 0); i < order.length; i++) {
      const mode = order[i]!;
      try {
        const response = await this.post(request, mode);
        this.format = mode;
        return response;
      } catch (error) {
        const isLast = i === order.length - 1;
        const rejectedFormat =
          error instanceof GaussError && (error.status === 400 || error.status === 422);
        if (!rejectedFormat || isLast || !request.schema) {
          throw error;
        }
        warnings.push(
          `gauss endpoint rejected response_format "${mode}", falling back to "${order[i + 1]}"`,
        );
      }
    }
    throw new GaussError('exhausted response format fallbacks');
  }

  private async post(
    request: GaussRequest,
    mode: ResponseFormatMode = this.format,
  ): Promise<{ body: unknown; text: string }> {
    const messages: { role: string; content: string }[] = [];

    let system = request.system;
    if (request.schema && mode === 'prompt') {
      // No native structured output: put the contract in the prompt instead.
      system = [
        system ?? '',
        'Reply with a single JSON object matching this schema. No prose, no markdown fences.',
        JSON.stringify(request.schema.schema),
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: request.user });

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      temperature: request.temperature ?? 0,
      stream: false,
    };
    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }
    if (request.schema) {
      if (mode === 'json_schema') {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: request.schema.name, schema: request.schema.schema, strict: true },
        };
      } else if (mode === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
    }

    const parsed = await this.fetchWithRetry(body, request.signal);
    return { body: parsed, text: extractText(parsed) };
  }

  private async fetchWithRetry(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        // Send auth only when a key is set. A local stand-in model (Ollama,
        // LM Studio) exposes an OpenAI-compatible endpoint with no key, and
        // sending "Bearer undefined" would make some of them reject the request.
        if (this.options.apiKey) {
          headers.authorization = `Bearer ${this.options.apiKey}`;
        }
        const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: combined,
        });

        if (response.ok) {
          return await response.json();
        }

        const text = await response.text().catch(() => '');
        const error = new GaussError(
          `Gauss returned ${response.status}`,
          response.status,
          text.slice(0, 2_000),
        );
        // 4xx other than 429 will not improve on retry.
        if (response.status < 500 && response.status !== 429) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        if (error instanceof GaussError && error.status && error.status < 500) {
          throw error;
        }
        if (signal?.aborted) {
          throw error;
        }
        lastError = error;
      }

      if (attempt < maxRetries) {
        await delay(250 * 2 ** attempt);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new GaussError('Gauss request failed', undefined, String(lastError));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === 'string' ? message.content : '';
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Pulls a JSON object out of a reply that may be wrapped in prose or fences.
 * Small models add "Here is the JSON:" more often than one would like.
 */
export function extractJson<T>(text: string): ParseResult<T> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty reply' };
  }

  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  let lastError = 'no JSON found';
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as T };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError };
}
