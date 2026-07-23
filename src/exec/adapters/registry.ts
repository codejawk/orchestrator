import type { AdapterId } from '../../types/ir.ts';
import { probeAll } from './probe.ts';
import type { ProbeResult } from './types.ts';

/**
 * Caches probe results for the session.
 *
 * Probing spawns three processes and each cold start costs a second or two, so
 * we do it once at activation and on explicit refresh rather than per run. The
 * cache is deliberately not persisted across sessions: a developer who just
 * installed or upgraded a CLI should get the new answer on reload, not a stale
 * one from last week.
 */
export class AdapterRegistry {
  private results = new Map<AdapterId, ProbeResult>();
  private inFlight: Promise<ProbeResult[]> | undefined;

  private readonly bins: () => Record<Exclude<AdapterId, 'gauss'>, string>;

  constructor(bins: () => Record<Exclude<AdapterId, 'gauss'>, string>) {
    this.bins = bins;
  }

  async refresh(): Promise<ProbeResult[]> {
    this.inFlight ??= probeAll(this.bins()).then((results) => {
      this.results.clear();
      for (const result of results) {
        this.results.set(result.adapter, result);
      }
      this.inFlight = undefined;
      return results;
    });
    return this.inFlight;
  }

  async all(): Promise<ProbeResult[]> {
    if (this.results.size === 0) {
      return this.refresh();
    }
    return [...this.results.values()];
  }

  async get(adapter: AdapterId): Promise<ProbeResult | undefined> {
    await this.all();
    return this.results.get(adapter);
  }

  /** Adapters that can actually execute a subtask right now. */
  async usable(): Promise<AdapterId[]> {
    const results = await this.all();
    return results.filter((r) => r.status !== 'unavailable').map((r) => r.adapter);
  }
}
