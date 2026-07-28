import * as vscode from 'vscode';
import type { AdapterId } from './types/ir.ts';
import type { ModelPrice } from './accounting/pricing.ts';

export const SECTION = 'orchestrator';
export const GAUSS_KEY_SECRET = 'orchestrator.gauss.apiKey';
/** Per-workspace salt for audit content hashes. Stored in SecretStorage. */
export const AUDIT_SALT_SECRET = 'orchestrator.audit.salt';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function adapterBins(): Record<Exclude<AdapterId, 'gauss'>, string> {
  const c = config();
  return {
    claude: c.get<string>('adapters.claude.path', 'claude'),
    codex: c.get<string>('adapters.codex.path', 'codex'),
    gemini: c.get<string>('adapters.gemini.path', 'gemini'),
  };
}

/**
 * Environment injected into every spawned CLI.
 *
 * The CLIs authenticate themselves — this extension never handles an Anthropic,
 * OpenAI or Google key. But a VS Code window launched from Finder or the Dock
 * does not inherit your shell profile, so `ANTHROPIC_API_KEY` set in `.zshrc`
 * simply is not in `process.env` and the CLI fails with an auth error that
 * looks like a bug in this extension. This setting is the escape hatch.
 *
 * Prefer values that reference a helper (`apiKeyHelper`, a credential process)
 * over pasting a key into settings.json, which is usually a tracked file.
 */
export function adapterEnv(): Record<string, string> {
  return config().get<Record<string, string>>('adapters.env', {});
}

export { resolveBare, type BareMode } from './exec/bareAuth.ts';

export function claudeBareMode(): import('./exec/bareAuth.ts').BareMode {
  return config().get('adapters.claude.bare', 'auto');
}

export interface GaussConfig {
  baseUrl: string;
  model: string;
}

export function gaussConfig(): GaussConfig {
  const c = config();
  return {
    baseUrl: c.get<string>('gauss.baseUrl', '').trim().replace(/\/+$/, ''),
    model: c.get<string>('gauss.model', 'gauss'),
  };
}

export function priceOverrides(): Record<string, Partial<ModelPrice>> {
  return config().get<Record<string, Partial<ModelPrice>>>('pricing', {});
}

export function baselineConfig(): { sampleRate: number; frontierModel: string } {
  const c = config();
  return {
    sampleRate: c.get<number>('baseline.sampleRate', 0.05),
    frontierModel: c.get<string>('baseline.frontierModel', 'claude-opus-4-8'),
  };
}

export interface PolicyConfig {
  codenames: string[];
  allowRestrictedOverride: boolean;
}

export function policyConfig(): PolicyConfig {
  const c = config();
  return {
    codenames: c.get<string[]>('policy.codenames', []),
    allowRestrictedOverride: c.get<boolean>('policy.allowRestrictedOverride', false),
  };
}

export function budgetConfig(): { maxRunUsd: number } {
  return { maxRunUsd: config().get<number>('budget.maxRunUsd', 0) };
}

/**
 * Whether the data-classification layer is active.
 *
 * On (default): files are classified, a review gate stands between the
 * workspace and any external model, and sensitive content is pinned to the
 * planner. Off: the pipeline is pure orchestration — clarify, optimize,
 * decompose, route, execute — with every selected file free to go to the best
 * model. Turn it off on a personal machine with no sensitive code; keep it on
 * anywhere Samsung-confidential material could be present.
 */
export function securityEnabled(): boolean {
  return config().get<boolean>('security.enabled', true);
}

export interface ScanConfig {
  maxFiles: number;
  maxFileBytes: number;
  digestTokens: number;
  batchSize: number;
  deepDigestTokens: number;
  deepBatchSize: number;
  contextBudgetTokens: number;
}

export function scanConfig(): ScanConfig {
  const c = config();
  return {
    maxFiles: c.get<number>('scan.maxFiles', 2_000),
    maxFileBytes: c.get<number>('scan.maxFileBytes', 2 * 1024 * 1024),
    digestTokens: c.get<number>('scan.digestTokens', 400),
    batchSize: c.get<number>('scan.batchSize', 12),
    // Deep precheck sends more of each file and more files per call, because it
    // runs once and the planner has the context budget.
    deepDigestTokens: c.get<number>('scan.deepDigestTokens', 1_500),
    deepBatchSize: c.get<number>('scan.deepBatchSize', 20),
    contextBudgetTokens: c.get<number>('context.budgetTokens', 30_000),
  };
}
