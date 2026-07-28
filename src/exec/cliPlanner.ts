import type { CostRecord, Subtask } from '../types/ir.ts';
import type { GaussRequest, GaussResult, Planner } from '../planner/gauss.ts';
import type { ModelAdapter } from './adapters/types.ts';

/**
 * A planner backed by one of the developer's own CLIs — Claude, Codex or Gemini
 * — instead of the internal Gauss HTTP endpoint or a local Ollama stand-in.
 *
 * This is what lets planning run on your real account. It implements the same
 * `Planner` interface the planner stages depend on, so nothing in `src/planner`
 * changes or learns that a CLI is involved: it delegates each planning call to a
 * `ModelAdapter.run()`, which already knows how to invoke the CLI headlessly,
 * enforce a JSON schema, and meter the cost.
 *
 * It lives here, in `src/exec`, not in `src/planner` — the isolation invariant
 * forbids the planner from importing an adapter, and this class does. The
 * pipeline wires it in from the outside.
 *
 * Trade-off worth stating: a strong CLI (Claude, Gemini) plans far better than
 * an 8B local model, but each planning call spawns a process (~1–3s) and, on a
 * subscription, counts against your usage. Planning makes a handful of calls per
 * request, so this is usually a good trade for the quality gain.
 */
export class CliPlanner implements Planner {
  readonly model: string;
  readonly costs: CostRecord[] = [];

  private readonly adapter: ModelAdapter;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(args: {
    adapter: ModelAdapter;
    model: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) {
    this.adapter = args.adapter;
    this.model = args.model;
    this.cwd = args.cwd;
    this.env = args.env;
    this.timeoutMs = args.timeoutMs ?? 120_000;
  }

  totalUsd(): number {
    return this.costs.reduce((sum, record) => sum + record.usd, 0);
  }

  async complete<T = unknown>(request: GaussRequest): Promise<GaussResult<T>> {
    const subtask = this.plannerSubtask(request);

    const result = await this.adapter.run({
      subtask,
      prompt: request.user,
      ...(request.system ? { systemPrompt: request.system } : {}),
      output: subtask.output,
      cwd: this.cwd,
      scopeDirs: [],
      env: this.env,
      timeoutMs: this.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    this.costs.push(result.cost);

    const warnings = [...result.warnings];
    if (!result.ok && result.error) {
      warnings.push(`${request.purpose}: planner call failed — ${result.error}`);
    }

    return {
      text: result.text,
      ...(result.structured !== undefined ? { data: result.structured as T } : {}),
      cost: result.cost,
      warnings,
    };
  }

  /**
   * A synthetic subtask so the adapter has something to run. Planning is
   * `analyze`-shaped — it reads text and returns a structured judgement, never
   * edits — and the schema, when present, is what forces clean JSON out.
   */
  private plannerSubtask(request: GaussRequest): Subtask {
    return {
      id: `plan:${request.purpose}`,
      dependsOn: [],
      kind: 'analyze',
      goal: request.purpose,
      context: [],
      consumes: [],
      adapter: this.adapter.id,
      model: this.model,
      output: {
        format: request.schema ? 'json' : 'prose',
        maxTokens: request.maxTokens ?? 1_024,
        reasoning: 'low',
        ...(request.schema ? { schema: request.schema.schema } : {}),
      },
      estimate: { inTokens: 0, outTokens: 0, usd: 0 },
    };
  }
}
