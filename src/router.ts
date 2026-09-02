import { clampEffort, defaultRoute, findModel, nearestOn } from './catalog.ts';
import type { Adapter, Difficulty, Effort, Kind, ModelChoice } from './types.ts';
import type { ProviderUsage } from './usage.ts';

export interface UsageHeadroom {
  claude: ProviderUsage;
  codex: ProviderUsage;
  /** Headroom % below which a provider is avoided if the other is healthier. */
  softFloor?: number;
}

const DEFAULT_SOFT_FLOOR = 20;

/** True when a provider is exhausted or below the soft floor. */
function isLow(u: ProviderUsage, floor: number): boolean {
  return u.known && (Boolean(u.reachedLimit) || (u.headroom !== undefined && u.headroom < floor));
}

/**
 * The routing algorithm: main-model recommendation + deterministic guardrails
 * → a concrete model and effort.
 *
 * Opus gets to choose from the verified catalog, but the app still refuses
 * nonexistent models, unsupported efforts, or obviously underpowered choices.
 */

export interface Route {
  adapter: Adapter;
  model: string;
  effort: Effort;
  note: string;
}

export function routeFor(
  kind: Kind,
  difficulty: Difficulty,
  choice?: Partial<ModelChoice>,
  usage?: UsageHeadroom,
): Route {
  const base = baseRoute(kind, difficulty, choice);
  return applyUsage(base, difficulty, usage);
}

function baseRoute(kind: Kind, difficulty: Difficulty, choice?: Partial<ModelChoice>): Route {
  const fallback = defaultRoute(kind, difficulty);
  const fallbackRoute = (why: string): Route => ({
    adapter: fallback.entry.adapter,
    model: fallback.entry.id,
    effort: fallback.effort,
    note: `${why} Defaulted to ${fallback.entry.label} at ${fallback.effort}.`,
  });

  if (!choice?.adapter || !choice.model) {
    return fallbackRoute('No valid model choice from main model.');
  }

  const entry = findModel(choice.adapter, choice.model);
  if (!entry) {
    return fallbackRoute(`Invalid model choice ${choice.adapter}/${choice.model}.`);
  }

  if (kind === 'review') {
    const review = defaultRoute(kind, difficulty);
    return {
      adapter: review.entry.adapter,
      model: review.entry.id,
      effort: review.effort,
      note: 'Review work is always routed to the strongest verifier.',
    };
  }

  if (difficulty === 'hard' && entry.weight < 7) {
    return fallbackRoute(`Main model chose ${entry.label}, but hard work needs a stronger model.`);
  }

  const requestedEffort = choice.effort ?? fallback.effort;
  const effort = clampEffort(entry, requestedEffort);
  const effortNote = effort === requestedEffort ? '' : ` Effort clamped from ${requestedEffort} to ${effort}.`;
  const reason = choice.reason?.trim() ? ` ${choice.reason.trim()}` : '';

  return {
    adapter: entry.adapter,
    model: entry.id,
    effort,
    note: `Main model chose ${entry.label} at ${effort}.${reason}${effortNote}`,
  };
}

/**
 * Headroom-aware demotion. Difficulty stays the primary driver (it picked the
 * model), but if the chosen provider is exhausted OR below the soft floor, the
 * subtask moves to the other provider — provided the other one is actually
 * healthier. This is the "route by how much is left" step.
 */
function applyUsage(route: Route, difficulty: Difficulty, usage?: UsageHeadroom): Route {
  if (!usage) {
    return route;
  }
  const floor = usage.softFloor ?? DEFAULT_SOFT_FLOOR;
  const chosen = route.adapter === 'claude' ? usage.claude : usage.codex;
  const other: Adapter = route.adapter === 'claude' ? 'codex' : 'claude';
  const otherUsage = other === 'claude' ? usage.claude : usage.codex;

  // Chosen provider is fine → keep the difficulty-based choice.
  if (!isLow(chosen, floor)) {
    return route;
  }

  // Chosen is low/exhausted. Only move if the other provider is a better bet:
  // known and not itself low. (If the chosen is fully exhausted we still move to
  // an unknown other, since staying is a guaranteed failure.)
  const otherViable = otherUsage.known ? !isLow(otherUsage, floor) : Boolean(chosen.reachedLimit);
  if (!otherViable) {
    const why = chosen.reachedLimit ? 'exhausted' : `low (${chosen.headroom}% left)`;
    return { ...route, note: `${route.note} ${route.adapter} ${why} but ${other} is no better — keeping ${route.adapter}.` };
  }

  const current = findModel(route.adapter, route.model);
  const target = nearestOn(other, current?.weight ?? (difficulty === 'hard' ? 9 : 5));
  const effort = clampEffort(target, route.effort);
  const why = chosen.reachedLimit ? 'out of quota' : `low on quota (${chosen.headroom}% left, floor ${floor}%)`;
  const otherHint = otherUsage.known && otherUsage.headroom !== undefined ? ` (${otherUsage.headroom}% left)` : '';
  return {
    adapter: target.adapter,
    model: target.id,
    effort,
    note: `${route.adapter} ${why} → rerouted to ${target.label}${otherHint} at ${effort}.`,
  };
}

export function effortFor(adapter: Adapter, model: string, effort: Effort): Effort {
  const entry = findModel(adapter, model);
  if (!entry) {
    return effort;
  }
  return clampEffort(entry, effort);
}
