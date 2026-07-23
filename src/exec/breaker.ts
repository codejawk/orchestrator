import type { AdapterId } from '../types/ir.ts';

/**
 * A per-adapter circuit breaker, scoped to one run.
 *
 * The failure it exists for: a CLI that hangs or dies on every invocation.
 * Without a breaker, a plan with eight subtasks routed to a broken `claude`
 * spawns and times out eight times — eight process launches, eight timeout
 * waits, and eight identical error messages, when the first two told us
 * everything. Worse, if timeouts are long, one broken adapter stalls the whole
 * queue.
 *
 * After `threshold` infrastructure failures — spawn errors and timeouts, not
 * model errors — the breaker trips and the runner skips any remaining subtasks
 * on that adapter with a clear reason. A model that simply produced a bad answer
 * does not trip it; that is a content failure, not an availability one, and
 * tripping on it would route perfectly healthy work away for no reason.
 *
 * Scoped to a run, not persisted: a CLI that was down five minutes ago should
 * get a fresh chance on the next request, not stay blacklisted.
 */
export class CircuitBreaker {
  private readonly failures = new Map<AdapterId, number>();
  private readonly threshold: number;

  constructor(threshold = 2) {
    this.threshold = threshold;
  }

  isTripped(adapter: AdapterId): boolean {
    return (this.failures.get(adapter) ?? 0) >= this.threshold;
  }

  /** Records an infrastructure failure. Returns true if this trips the breaker. */
  recordFailure(adapter: AdapterId): boolean {
    const next = (this.failures.get(adapter) ?? 0) + 1;
    this.failures.set(adapter, next);
    return next === this.threshold;
  }

  /** A success resets the count: a flaky adapter that recovers is not punished. */
  recordSuccess(adapter: AdapterId): void {
    this.failures.delete(adapter);
  }

  reason(adapter: AdapterId): string {
    return `${adapter} failed ${this.failures.get(adapter) ?? 0} times this run and was taken out of rotation. Remaining ${adapter} subtasks were skipped.`;
  }
}

/**
 * Running-total spend guard.
 *
 * The reviewer's scenario: a planner fans a request the user thought was cheap
 * into planner → three models → review, and the bill is 5x what they expected.
 * Plan approval catches the *forecast*, but forecasts are estimates and a
 * runaway subtask can blow past one. This is the hard stop that plan approval
 * cannot be: once real, provider-reported spend crosses the ceiling, no further
 * subtask is dispatched.
 *
 * Gauss spend counts too. Planning is not free, and a cap that ignored it would
 * let a pathological planning loop run unbounded.
 */
export class SpendGuard {
  private spent: number;
  private readonly capUsd: number;

  /** `capUsd <= 0` means no cap. `alreadySpent` seeds it with planning cost. */
  constructor(capUsd: number, alreadySpent = 0) {
    this.capUsd = capUsd;
    this.spent = alreadySpent;
  }

  get total(): number {
    return this.spent;
  }

  get enabled(): boolean {
    return this.capUsd > 0;
  }

  add(usd: number): void {
    this.spent += usd;
  }

  /** True when the cap has been reached and further dispatch must stop. */
  get exceeded(): boolean {
    return this.enabled && this.spent >= this.capUsd;
  }

  reason(): string {
    return `Run spend cap of $${this.capUsd.toFixed(2)} reached ($${this.spent.toFixed(2)} spent). Remaining subtasks were skipped. Raise orchestrator.budget.maxRunUsd to allow more.`;
  }
}
