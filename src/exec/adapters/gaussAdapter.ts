import type { GaussClient } from '../../planner/gauss.ts';
import type { ModelAdapter, ProbeResult, RunRequest, RunResult } from './types.ts';

/**
 * Executes a subtask on Gauss.
 *
 * This is the path every restricted subtask takes, so it is the one that has to
 * work when it matters most. It is also the simplest: Gauss is a plain LLM over
 * HTTP with no CLI, no sandbox and no agent loop, so the adapter is a thin
 * wrapper over the same client the planner uses.
 *
 * `probe` reports capabilities honestly rather than flatteringly. Gauss cannot
 * strip an agent preamble it never had, and whether it honours a JSON schema
 * depends on the endpoint — `GaussClient` discovers that at runtime and falls
 * back, so we report the optimistic case and let warnings tell the truth.
 */
export class GaussAdapter implements ModelAdapter {
  readonly id = 'gauss' as const;

  private readonly client: GaussClient;
  private readonly configured: boolean;

  constructor(client: GaussClient, configured: boolean) {
    this.client = client;
    this.configured = configured;
  }

  async probe(): Promise<ProbeResult> {
    return {
      adapter: 'gauss',
      status: this.configured ? 'ready' : 'unavailable',
      bin: 'http',
      capabilities: {
        headless: true,
        structuredOutput: true,
        outputSchema: true,
        // No agent context to strip, and no filesystem to restrict — every
        // byte Gauss sees is one this extension chose to send.
        stripsAgentContext: true,
        restrictTools: true,
        modelSelection: true,
        scopeDirs: true,
        resume: false,
        reportsUsage: true,
      },
      notes: this.configured
        ? []
        : ['orchestrator.gauss.baseUrl is not set. Nothing can run until it is — including every restricted subtask.'],
      probedAt: new Date().toISOString(),
    };
  }

  async run(request: RunRequest): Promise<RunResult> {
    const { subtask, output } = request;

    try {
      const result = await this.client.complete({
        purpose: `subtask:${subtask.id}`,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        user: request.prompt,
        ...(output.schema ? { schema: { name: `subtask_${subtask.kind}`, schema: output.schema } } : {}),
        maxTokens: output.maxTokens,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      return {
        ok: true,
        text: result.text,
        ...(result.data !== undefined ? { structured: result.data } : {}),
        cost: result.cost,
        warnings: result.warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        text: '',
        cost: {
          adapter: 'gauss',
          model: this.client.model,
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 },
          usd: 0,
          usdReported: false,
          durationMs: 0,
        },
        warnings: [],
        error: message,
      };
    }
  }
}
