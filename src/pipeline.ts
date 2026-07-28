import * as vscode from 'vscode';
import type { AdapterId, ContextRef, ExecutionPlan, RunAccounting, SavingsReport, Tier } from './types/ir.ts';
import { TIER_RANK } from './types/ir.ts';
import { PriceTable } from './accounting/pricing.ts';
import { buildSavingsReport, fitCalibration, modelBaseline, type CalibrationSample } from './accounting/baseline.ts';
import { sumUsage } from './accounting/meter.ts';
import { GaussClient } from './planner/gauss.ts';
import { analyzeIntake, mergeAnswers, type ClarificationAnswer, type IntakeOutcome } from './planner/intake.ts';
import { scanFiles, type FileVerdict, type ScanReport } from './planner/scanner.ts';
import { selectContext, type CandidateFile } from './planner/contextSelector.ts';
import { compilePrompt, renderIR } from './planner/compiler.ts';
import { decompose } from './planner/decompose.ts';
import { synthesize } from './planner/synthesize.ts';
import { route, totalEstimate, DEFAULT_TIERS } from './planner/router.ts';
import { assessPrompt, SessionTaint, type PromptAssessment } from './planner/promptGuard.ts';
import { estimateTokens } from './optimize/tokens.ts';
import { ApprovalStore, partitionByRouting, type ApprovalDecision } from './policy/approvals.ts';
import { codenameRule, DEFAULT_RULES, prefilter, type PatternRule } from './policy/patterns.ts';
import { OrchestratorSession } from './session.ts';
export { OrchestratorSession, type ConversationTurn } from './session.ts';
import type { PrecheckEntry } from './panel/SecurityMapPanel.ts';
import { executePlan, type ExecutionOutcome, type RunnerEvent } from './exec/runner.ts';
import { EgressGuard } from './policy/egress.ts';
import { AuditLog, newSalt, type AuditRecord } from './audit/log.ts';
import { ClaudeAdapter } from './exec/adapters/claude.ts';
import { CodexAdapter } from './exec/adapters/codex.ts';
import { GeminiAdapter } from './exec/adapters/gemini.ts';
import { GaussAdapter } from './exec/adapters/gaussAdapter.ts';
import type { ModelAdapter } from './exec/adapters/types.ts';
import type { AdapterRegistry } from './exec/adapters/registry.ts';
import {
  adapterBins,
  adapterEnv,
  baselineConfig,
  budgetConfig,
  claudeBareMode,
  gaussConfig,
  policyConfig,
  priceOverrides,
  resolveBare,
  scanConfig,
  securityEnabled,
  AUDIT_SALT_SECRET,
  GAUSS_KEY_SECRET,
} from './config.ts';

const AUDIT_LOG_KEY = 'orchestrator.audit.v1';
import {
  buildCandidates,
  collectFiles,
  createFileReader,
  workspaceRoot,
  type WorkspaceFile,
} from './workspace.ts';

/**
 * The pipeline.
 *
 *   0. GUARD      redact and assess the prompt itself
 *   1. SWEEP      free regex prefilter over every file — no model, no cost
 *   2. CLARIFY    Gauss asks up to three questions if the request is vague
 *   3. SELECT     Gauss picks the ~20 relevant files from skeletons
 *   4. SCAN       Gauss classifies only those files
 *   5. REVIEW     you approve, per file
 *   6. PLAN       compile, decompose, route
 *   7. APPROVE    you approve the plan
 *   8. EXECUTE    dispatch to CLIs
 *   9. REPORT     actual versus modelled baseline
 *
 * The ordering of 1–4 is the expensive lesson. Classifying an entire platform
 * tree up front costs hundreds of Gauss calls to produce verdicts for thousands
 * of files a given request will never look at. Sweeping with regexes is free,
 * so it covers everything; the model only ever judges what the request actually
 * needs. On a kernel tree that is the difference between ~2000 files and ~20.
 *
 * Clarification comes before selection deliberately: you cannot choose the right
 * files for a request nobody has pinned down yet.
 */

const CALIBRATION_KEY = 'orchestrator.calibration.v1';
const SCAN_CACHE_KEY = 'orchestrator.scanCache.v1';


export interface SweepResult {
  totalFiles: number;
  /** Files the regex sweep alone marked restricted. Never offered externally. */
  restricted: string[];
  skipped: { path: string; reason: string }[];
}

export class Pipeline {
  private readonly context: vscode.ExtensionContext;
  private readonly registry: AdapterRegistry;
  private readonly prices: PriceTable;
  readonly approvals: ApprovalStore;
  private gaussClient?: GaussClient;
  private auditLog?: AuditLog;

  constructor(context: vscode.ExtensionContext, registry: AdapterRegistry) {
    this.context = context;
    this.registry = registry;
    this.prices = new PriceTable(priceOverrides());
    this.approvals = new ApprovalStore(
      {
        get: <T>(key: string) => context.workspaceState.get<T>(key),
        update: (key, value) => Promise.resolve(context.workspaceState.update(key, value)),
      },
      policyConfig().allowRestrictedOverride,
    );
  }

  /**
   * The audit log, created on first use.
   *
   * Records persist in workspaceState and the salt lives in SecretStorage, so
   * the content hashes cannot be recomputed by anyone who only has the log. A
   * production deployment should point the store at an append-only file and
   * anchor `log.head()` somewhere the developer cannot rewrite; the interface is
   * shaped for that without changing callers.
   */
  async audit(): Promise<AuditLog> {
    if (this.auditLog) {
      return this.auditLog;
    }
    let salt = await this.context.secrets.get(AUDIT_SALT_SECRET);
    if (!salt) {
      salt = newSalt();
      await this.context.secrets.store(AUDIT_SALT_SECRET, salt);
    }
    this.auditLog = new AuditLog(
      {
        load: () => this.context.workspaceState.get<AuditRecord[]>(AUDIT_LOG_KEY) ?? [],
        save: (records) => Promise.resolve(this.context.workspaceState.update(AUDIT_LOG_KEY, records)),
      },
      salt,
    );
    return this.auditLog;
  }

  private rules(): PatternRule[] {
    const rules = [...DEFAULT_RULES];
    const codenames = codenameRule(policyConfig().codenames);
    if (codenames) {
      rules.push(codenames);
    }
    return rules;
  }

  private async gauss(): Promise<GaussClient> {
    if (this.gaussClient) {
      return this.gaussClient;
    }
    const config = gaussConfig();
    if (!config.baseUrl) {
      throw new Error(
        'orchestrator.gauss.baseUrl is not set. Planning runs only on Gauss, so nothing can proceed without it.',
      );
    }
    const apiKey = (await this.context.secrets.get(GAUSS_KEY_SECRET)) ?? '';
    // A key is required unless the endpoint is a keyless local stand-in — a
    // model on localhost, used while the real Gauss endpoint is not yet wired.
    if (!apiKey && !isLocalEndpoint(config.baseUrl)) {
      throw new Error(
        'No planner API key stored. Run "Orchestrator: Set Gauss API Key" — or point orchestrator.gauss.baseUrl at a local model (localhost), which needs no key.',
      );
    }
    this.gaussClient = new GaussClient({
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model,
      prices: this.prices,
    });
    return this.gaussClient;
  }

  /** New client per run, so planning cost is attributed to that run alone. */
  resetGauss(): void {
    this.gaussClient = undefined;
  }

  // -------------------------------------------------------------------------
  // Stage 0 — guard the prompt
  // -------------------------------------------------------------------------

  /**
   * Redacts and assesses what the user typed before it goes anywhere.
   *
   * The file gate does not cover the chat box, and the chat box is where the
   * dumpstate gets pasted.
   */
  guardPrompt(session: OrchestratorSession, prompt: string, extraText = ''): PromptAssessment {
    const combined = extraText ? `${prompt}\n\n${extraText}` : prompt;
    const assessment = assessPrompt(combined, { rules: this.rules() });

    session.originalPrompt = combined;
    session.guardedPrompt = assessment.redaction.text;
    // Append, not replace: a follow-up turn's redactions join the conversation's
    // map so reveal() still restores identifiers from earlier turns.
    session.redactions.push(...assessment.redaction.redactions);
    session.assessment = assessment;
    // Tainting is a security behaviour; with security off, a request is never
    // pinned to the planner and everything routes to the best model.
    if (securityEnabled()) {
      session.taint.absorb(assessment);
    }

    return assessment;
  }

  // -------------------------------------------------------------------------
  // Stage 1 — free sweep
  // -------------------------------------------------------------------------

  /**
   * Regex sweep over every file. No model call, so it covers the whole tree at
   * zero cost and catches key material and secure-boot paths regardless of what
   * the request later asks for.
   */
  async sweep(
    session: OrchestratorSession,
    folder: vscode.Uri | undefined,
    token?: vscode.CancellationToken,
  ): Promise<SweepResult> {
    const settings = scanConfig();
    const collected = await collectFiles(folder, settings.maxFiles, settings.maxFileBytes, token);
    session.files = collected.files;
    session.sweepSkipped = collected.skipped;

    const rules = this.rules();
    const restricted: string[] = [];

    for (const file of collected.files) {
      const result = prefilter(file.path, file.content, rules);
      session.sweep.set(file.path, { tier: result.tier, reasons: result.reasons });
      if (result.tier === 'restricted') {
        restricted.push(file.path);
      }
    }

    return { totalFiles: collected.files.length, restricted, skipped: collected.skipped };
  }

  /**
   * Reads files the user named in the prompt, even if they exceed the bulk size
   * limit.
   *
   * The size cap exists to stop a broad sweep from slurping every giant data
   * file — not to refuse a file the user explicitly asked about. When someone
   * says "explain RA_2026_finder.html", that file must be read regardless of
   * size. A generous hard ceiling still applies so a truly enormous file cannot
   * exhaust memory, and binary files are still refused (reading a spreadsheet as
   * text is useless). Very large files are truncated later, at context assembly,
   * so this does not blow the model's context window.
   */
  async includeNamedFiles(session: OrchestratorSession, prompt: string): Promise<string[]> {
    const root = workspaceRoot();
    if (!root) {
      return [];
    }

    // Filename-shaped tokens from the prompt: something.ext.
    const candidates = new Set(
      [...prompt.matchAll(/[\w./\\-]+\.[A-Za-z0-9]{1,8}\b/g)].map((m) => m[0].replace(/\\/g, '/')),
    );
    const matchesNamed = (path: string): boolean => {
      const base = path.split('/').pop() ?? path;
      return [...candidates].some(
        (c) => path.endsWith(c) || c.endsWith(base) || (c.split('/').pop() ?? c) === base,
      );
    };

    // Pin every already-read file the prompt names, so selection always keeps
    // it even if the model selector overlooks it. Oversized named files are read
    // in below and pinned there.
    session.pinnedPaths = session.files.filter((file) => matchesNamed(file.path)).map((file) => file.path);

    if (candidates.size === 0) {
      return [];
    }

    const HARD_MAX = 25 * 1024 * 1024;
    const included: string[] = [];
    const rules = this.rules();

    // Match named files against those the sweep skipped for size.
    for (const skip of session.sweepSkipped) {
      const base = skip.path.split('/').pop() ?? skip.path;
      const named = [...candidates].some(
        (c) => skip.path.endsWith(c) || c.endsWith(base) || (c.split('/').pop() ?? c) === base,
      );
      if (!named || session.files.some((file) => file.path === skip.path)) {
        continue;
      }
      try {
        const uri = vscode.Uri.joinPath(root, skip.path);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > HARD_MAX) {
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.includes(0)) {
          continue; // binary — not readable as text
        }
        const content = new TextDecoder().decode(bytes);
        session.files.push({ path: skip.path, uri, content, bytes: stat.size });
        const pre = prefilter(skip.path, content, rules);
        session.sweep.set(skip.path, { tier: pre.tier, reasons: pre.reasons });
        included.push(skip.path);
        if (!session.pinnedPaths.includes(skip.path)) {
          session.pinnedPaths.push(skip.path);
        }
      } catch {
        // Unreadable; leave it in the skipped list.
      }
    }

    if (included.length > 0) {
      session.sweepSkipped = session.sweepSkipped.filter((s) => !included.includes(s.path));
    }
    return included;
  }

  // -------------------------------------------------------------------------
  // Stage 2 — clarify
  // -------------------------------------------------------------------------

  async intake(session: OrchestratorSession, token?: vscode.CancellationToken): Promise<IntakeOutcome> {
    const gauss = await this.gauss();
    const outcome = await analyzeIntake(
      session.guardedPrompt,
      gauss,
      {
        paths: session.files.map((file) => file.path),
        ...(vscode.window.activeTextEditor
          ? { activePath: vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false) }
          : {}),
      },
      token ? toAbortSignal(token) : undefined,
    );
    session.intake = outcome;
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Stages 3 and 4 — select, then scan only what was selected
  // -------------------------------------------------------------------------

  /**
   * Picks the relevant files, then classifies only those.
   *
   * Files the free sweep already marked restricted are excluded from candidacy
   * entirely — the selector never sees them, so it cannot pick them and the
   * user is never asked to make a judgement call about a private key.
   */
  async selectAndScan(
    session: OrchestratorSession,
    progress?: (message: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<{ report: ScanReport; excludedBySweep: string[]; warnings: string[] }> {
    const gauss = await this.gauss();
    const signal = token ? toAbortSignal(token) : undefined;
    const settings = scanConfig();
    const warnings: string[] = [];

    const secure = securityEnabled();

    // With security on, the sweep's restricted files are kept out of candidacy.
    // With it off, nothing is excluded — the flow is pure orchestration.
    const excludedBySweep = secure
      ? session.files.filter((file) => session.sweep.get(file.path)?.tier === 'restricted').map((file) => file.path)
      : [];
    const excluded = new Set(excludedBySweep);
    const eligible = session.files.filter((file) => !excluded.has(file.path));

    progress?.('Building file outlines…');
    session.candidates = await buildCandidates(eligible, () => true, token);

    progress?.('Choosing relevant files…');
    const merged = this.mergedPrompt(session);
    const selection = await selectContext(merged, session.candidates, gauss, {
      budgetTokens: settings.contextBudgetTokens,
      ...(signal ? { signal } : {}),
    });
    warnings.push(...selection.warnings);

    // Force-include any file the user named in the prompt, as full content. The
    // selector is a model and can miss the obvious; an explicit "explain X" must
    // never fall through to "no files selected".
    const refs = [...selection.refs];
    const already = new Set(refs.map((ref) => ref.path));
    for (const path of session.pinnedPaths) {
      if (!already.has(path) && session.files.some((file) => file.path === path)) {
        const file = session.files.find((f) => f.path === path)!;
        refs.push({ path, mode: 'full', estTokens: estimateTokens(file.content, 'code'), rationale: 'named in the request' });
        already.add(path);
      }
    }

    const selectedPaths = new Set(refs.map((ref) => ref.path));
    session.selectedRefs = refs;

    // Security off: skip per-file classification and the review gate entirely.
    // Every selected file is treated as shareable and routed to the best model.
    if (!secure) {
      const report: ScanReport = {
        scannedAt: new Date().toISOString(),
        files: session.files
          .filter((file) => selectedPaths.has(file.path))
          .map((file) => ({
            path: file.path,
            contentHash: '',
            tier: 'internal' as const,
            reasons: [],
            source: 'unscanned' as const,
            estTokens: estimateTokens(file.content, 'code'),
          })),
        skipped: [],
        costs: [],
        warnings: [],
      };
      session.scan = report;
      return { report, excludedBySweep, warnings };
    }

    progress?.(`Classifying ${selectedPaths.size} selected file${selectedPaths.size === 1 ? '' : 's'}…`);

    const cache = new Map<string, FileVerdict>(
      Object.entries(this.context.workspaceState.get<Record<string, FileVerdict>>(SCAN_CACHE_KEY) ?? {}),
    );

    const report = await scanFiles(
      session.files
        .filter((file) => selectedPaths.has(file.path))
        .map((file) => ({ path: file.path, content: file.content })),
      gauss,
      {
        rules: this.rules(),
        digestTokens: settings.digestTokens,
        batchSize: settings.batchSize,
        cache,
        ...(signal ? { signal } : {}),
      },
    );

    await this.context.workspaceState.update(SCAN_CACHE_KEY, Object.fromEntries(cache));
    session.scan = report;

    // A selected file that turns out to be restricted taints the run: the
    // request genuinely needs it, so there is no version of this plan that
    // works with an external model.
    const restricted = report.files.filter((file) => TIER_RANK[file.tier] >= TIER_RANK.restricted);
    if (restricted.length > 0) {
      session.taint.taintBecause(
        `${restricted.length} file${restricted.length === 1 ? '' : 's'} the request needs ` +
          `(${restricted.slice(0, 2).map((f) => f.path).join(', ')}${restricted.length > 2 ? ', …' : ''}) ` +
          'are restricted, so this run stays on Gauss.',
      );
    }

    const audit = await this.audit();
    await audit.append({
      event: 'scan',
      files: report.files.map((file) => file.path),
      decision:
        `${report.files.length} classified; ` +
        `${restricted.length} restricted, ${excludedBySweep.length} excluded by sweep`,
      usd: report.costs.reduce((sum, record) => sum + record.usd, 0),
    });

    return { report, excludedBySweep, warnings };
  }

  /**
   * Step 0: precheck the whole directory with the free regex sweep and return a
   * red/amber/green map. No model call, so it is instant and costs nothing —
   * a "look before you leap" the user runs before any request.
   */
  async precheck(
    folder?: vscode.Uri,
    token?: vscode.CancellationToken,
  ): Promise<{ entries: PrecheckEntry[]; scannedCount: number; skipped: { path: string; reason: string }[] }> {
    const settings = scanConfig();
    const collected = await collectFiles(folder, settings.maxFiles, settings.maxFileBytes, token);
    const rules = this.rules();

    const entries: PrecheckEntry[] = collected.files.map((file) => {
      const result = prefilter(file.path, file.content, rules);
      return {
        path: file.path,
        tier: result.tier,
        reasons: result.reasons.map((r) => ({ signal: r.signal, detail: r.detail })),
        estTokens: estimateTokens(file.content, 'code'),
        source: 'regex' as const,
      };
    });

    return { entries, scannedCount: collected.files.length, skipped: collected.skipped };
  }

  /**
   * Precheck phase 2: the planner model classifies the files the regex sweep
   * could not decide — unreleased plans, architecture sensitive by context, the
   * things a pattern cannot catch.
   *
   * This is the whole-directory model scan the user asked for. It leans on the
   * planner's large context: files are sent in bigger batches with a bigger
   * per-file sample than the per-request scan uses, because a precheck runs once
   * and the user has said Gauss can take it. Verdicts are cached by content hash,
   * so a second precheck of an unchanged tree costs nothing.
   */
  async precheckDeep(
    folder: vscode.Uri | undefined,
    progress: (message: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<{
    entries: PrecheckEntry[];
    scannedCount: number;
    skipped: { path: string; reason: string }[];
    costUsd: number;
  }> {
    const gauss = await this.gauss();
    const settings = scanConfig();
    const signal = token ? toAbortSignal(token) : undefined;

    const collected = await collectFiles(folder, settings.maxFiles, settings.maxFileBytes, token);

    const cache = new Map<string, FileVerdict>(
      Object.entries(this.context.workspaceState.get<Record<string, FileVerdict>>(SCAN_CACHE_KEY) ?? {}),
    );

    const report = await scanFiles(
      collected.files.map((file) => ({ path: file.path, content: file.content })),
      gauss,
      {
        rules: this.rules(),
        // Send more of each file and more files per call than a per-request
        // scan: a precheck runs once and the planner has the context budget.
        digestTokens: settings.deepDigestTokens,
        batchSize: settings.deepBatchSize,
        cache,
        onProgress: (done, total) => progress(`Phase 2 — classifying ${done}/${total} with the model…`),
        ...(signal ? { signal } : {}),
      },
    );

    await this.context.workspaceState.update(SCAN_CACHE_KEY, Object.fromEntries(cache));

    const entries: PrecheckEntry[] = report.files.map((file) => ({
      path: file.path,
      tier: file.tier,
      reasons: file.reasons.map((r) => ({ signal: r.signal, detail: r.detail })),
      estTokens: file.estTokens,
      source: file.source === 'gauss' || file.source === 'cached' ? ('model' as const) : ('regex' as const),
      ...(file.summary ? { summary: file.summary } : {}),
    }));

    return {
      entries,
      scannedCount: collected.files.length,
      skipped: collected.skipped,
      costUsd: report.costs.reduce((sum, record) => sum + record.usd, 0),
    };
  }

  async recordApprovals(verdicts: FileVerdict[], decision: ApprovalDecision) {
    const result = await this.approvals.recordMany(verdicts, decision);
    if (verdicts.length > 0) {
      const audit = await this.audit();
      await audit.append({
        event: 'approval',
        files: verdicts.map((verdict) => verdict.path),
        decision: `${decision}: ${result.applied} applied, ${result.rejected.length} rejected`,
      });
    }
    return result;
  }

  gaussOnlyPaths(report: ScanReport): Set<string> {
    // Security off: nothing is held back, so every file may go to any model.
    if (!securityEnabled()) {
      return new Set();
    }
    const { gaussOnly } = partitionByRouting(report.files, this.approvals);
    return new Set(gaussOnly.map((routing) => routing.path));
  }

  /**
   * Files in this scan that the user has not yet decided on.
   *
   * On a follow-up turn most selected files were already reviewed earlier, and
   * approvals persist by content hash — so we only re-open the review panel when
   * something genuinely new needs a decision. Restricted files are excluded:
   * they are never a decision. A stale approval (the file changed) counts as
   * pending, because it must be re-reviewed.
   */
  pendingReview(report: ScanReport): FileVerdict[] {
    // Security off: no review gate — everything is cleared for external models.
    if (!securityEnabled()) {
      return [];
    }
    return report.files.filter((file) => {
      if (TIER_RANK[file.tier] >= TIER_RANK.restricted) {
        return false;
      }
      const routing = this.approvals.route(file);
      const decided = this.approvals.lookup(file.path, file.contentHash);
      return !decided && !routing.externalAllowed;
    });
  }

  // -------------------------------------------------------------------------
  // Stage 6 — compile, decompose, route
  // -------------------------------------------------------------------------

  async buildPlan(
    session: OrchestratorSession,
    progress?: (message: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<{ plan: ExecutionPlan; warnings: string[]; compression: { before: number; after: number } }> {
    const gauss = await this.gauss();
    const signal = token ? toAbortSignal(token) : undefined;
    const warnings: string[] = [];

    if (!session.scan || !session.selectedRefs) {
      throw new Error('Nothing has been selected or scanned yet.');
    }

    const gaussOnly = this.gaussOnlyPaths(session.scan);
    const refs = session.selectedRefs;

    progress?.('Compiling prompt…');
    const compiled = await compilePrompt(
      this.mergedPrompt(session),
      refs,
      { tier: worstTierAmong(session.scan, refs.map((ref) => ref.path)), reasons: session.assessment?.reasons ?? [] },
      gauss,
      signal,
    );
    warnings.push(...compiled.warnings);

    progress?.('Decomposing…');
    const decomposed = await decompose(compiled.ir, gauss, signal);
    warnings.push(...decomposed.warnings);

    progress?.('Routing…');
    const usable = new Set(await this.registry.usable());
    usable.add('gauss');

    const routed = route({
      drafts: decomposed.drafts,
      gaussOnlyPaths: gaussOnly,
      availableAdapters: usable,
      tiers: DEFAULT_TIERS,
      prices: this.prices,
      sharedPrefixTokens: estimateTokens(renderIR(compiled.ir)),
      ...(session.taint.isTainted
        ? { forceGauss: { reason: session.taint.explanation || 'Sensitive content entered this conversation.' } }
        : {}),
    });
    warnings.push(...routed.warnings);

    const plan: ExecutionPlan = {
      id: `plan-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ir: compiled.ir,
      subtasks: routed.subtasks,
      estimate: totalEstimate(routed.subtasks),
      planningCost: aggregateCost(gauss),
    };

    session.plan = plan;
    return { plan, warnings, compression: compiled.compression };
  }

  private mergedPrompt(session: OrchestratorSession): string {
    const merged = mergeAnswers(
      session.guardedPrompt,
      session.intake?.restatedGoal ?? '',
      session.answers,
      (session.intake?.questions ?? [])
        .filter((question) => !session.answers.some((answer) => answer.id === question.id))
        .map((question) => ({
          question: question.question,
          assumptionIfSkipped: question.assumptionIfSkipped,
        })),
    );

    // Prepend the conversation recap so a follow-up ("now the fuel gauge too")
    // is planned with the earlier turns in view. It is a summary, not a
    // transcript, and it is only ever sent to Gauss during planning.
    const prior = session.priorContext();
    return prior ? `${prior}\n\nCURRENT REQUEST:\n${merged}` : merged;
  }

  // -------------------------------------------------------------------------
  // Stage 8 — execute
  // -------------------------------------------------------------------------

  async execute(
    session: OrchestratorSession,
    onEvent?: (event: RunnerEvent) => void,
    token?: vscode.CancellationToken,
  ): Promise<ExecutionOutcome> {
    const plan = session.plan;
    if (!plan) {
      throw new Error('No approved plan to execute.');
    }
    const root = workspaceRoot();
    if (!root) {
      throw new Error('No workspace folder is open.');
    }

    // When the session is tainted every subtask is already on Gauss, but the
    // dispatch check needs the path set too, in case a routing bug slipped one
    // through.
    const gaussOnly = session.scan ? this.gaussOnlyPaths(session.scan) : new Set<string>();
    if (session.taint.isTainted) {
      for (const ref of session.selectedRefs ?? []) {
        gaussOnly.add(ref.path);
      }
    }

    const audit = await this.audit();

    const outcome = await executePlan(plan, {
      adapters: await this.buildAdapters(),
      read: createFileReader(),
      cwd: root.fsPath,
      gaussOnlyPaths: gaussOnly,
      // Extension host env plus the overrides, so a key exported in a shell
      // profile the host never loaded can still reach the CLI.
      env: { ...process.env, ...adapterEnv() },
      // Every external dispatch re-scans its serialized payload here.
      egress: new EgressGuard({ rules: this.rules() }),
      audit,
      maxRunUsd: budgetConfig().maxRunUsd,
      // Planning is already spent, so the cap counts the whole run.
      spentBeforeRun: plan.planningCost.usd,
      ...(onEvent ? { onEvent } : {}),
      ...(token ? { signal: toAbortSignal(token) } : {}),
    });

    // Step 6: the orchestrator combines the subtask results into one answer.
    // Runs on the planner and works from the ledger's summaries, so it stays
    // cheap and its cost is folded into the run accounting like any planner call.
    try {
      const combined = await synthesize(
        plan.ir,
        outcome.ledger.snapshot(),
        await this.gauss(),
        token ? toAbortSignal(token) : undefined,
      );
      if (combined) {
        session.synthesis = combined.text;
        outcome.accounting.planning.push(combined.cost);
      }
    } catch {
      // Synthesis is a convenience, not a gate. If it fails the per-subtask
      // results are still shown; losing the combined view is not worth failing
      // the whole run.
    }

    await audit.append({
      event: 'report',
      planId: plan.id,
      decision: `${outcome.results.size} subtasks ran, ${outcome.skipped.length} skipped`,
      usd: [...outcome.accounting.planning, ...outcome.accounting.execution].reduce((s, r) => s + r.usd, 0),
    });

    session.outcome = outcome;
    return outcome;
  }

  /** Integrity check for the audit trail, surfaced by a command. */
  async verifyAudit(): Promise<{ ok: boolean; detail: string; count: number }> {
    const audit = await this.audit();
    const result = audit.verify();
    return {
      ok: result.ok,
      count: audit.all().length,
      detail: result.ok
        ? 'Every record hashes to the next; the chain is intact.'
        : `Chain broken at record ${result.brokenAt}: ${result.reason}. Entries from there on may have been altered.`,
    };
  }

  private async buildAdapters(): Promise<Map<AdapterId, ModelAdapter>> {
    const bins = adapterBins();
    const gauss = await this.gauss();
    // Decide --bare from config + the effective env, so a Pro/Max subscription
    // login (which --bare cannot use) works without the developer knowing why.
    const env = { ...process.env, ...adapterEnv() };
    const useBare = resolveBare(claudeBareMode(), env);
    return new Map<AdapterId, ModelAdapter>([
      ['claude', new ClaudeAdapter(bins.claude, this.prices, useBare)],
      ['codex', new CodexAdapter(bins.codex, this.prices)],
      ['gemini', new GeminiAdapter(bins.gemini, this.prices)],
      ['gauss', new GaussAdapter(gauss, Boolean(gaussConfig().baseUrl))],
    ]);
  }

  // -------------------------------------------------------------------------
  // Stage 9 — report
  // -------------------------------------------------------------------------

  buildReport(session: OrchestratorSession): SavingsReport | undefined {
    const { plan, outcome } = session;
    if (!plan || !outcome) {
      return undefined;
    }

    const calibration = fitCalibration(
      this.context.globalState.get<CalibrationSample[]>(CALIBRATION_KEY) ?? [],
    );

    const touched = new Set(plan.subtasks.flatMap((subtask) => subtask.context.map((ref) => ref.path)));
    const fullContextTokens = session.files
      .filter((file) => touched.has(file.path))
      .reduce((sum, file) => sum + estimateTokens(file.content, 'code'), 0);

    const observedOutput = sumUsage(
      [...outcome.accounting.planning, ...outcome.accounting.execution].map((record) => record.usage),
    ).outputTokens;

    const baseline = modelBaseline({
      ir: plan.ir,
      fullContextTokens,
      observedOutputTokens: observedOutput,
      frontierModel: baselineConfig().frontierModel,
      calibration,
      prices: this.prices,
    });

    return buildSavingsReport(outcome.accounting, baseline);
  }

  accountingFor(session: OrchestratorSession): RunAccounting | undefined {
    return session.outcome?.accounting;
  }
}

function aggregateCost(gauss: GaussClient) {
  return {
    adapter: 'gauss' as const,
    model: gauss.model,
    usage: sumUsage(gauss.costs.map((record) => record.usage)),
    usd: gauss.totalUsd(),
    usdReported: false,
    durationMs: gauss.costs.reduce((sum, record) => sum + record.durationMs, 0),
  };
}

function worstTierAmong(report: ScanReport, paths: string[]): Tier {
  const set = new Set(paths);
  return report.files
    .filter((file) => set.has(file.path))
    .reduce<Tier>((worst, file) => (TIER_RANK[file.tier] > TIER_RANK[worst] ? file.tier : worst), 'public');
}

/** Localhost endpoints are treated as keyless local stand-in models. */
function isLocalEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl);
}

export function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    token.onCancellationRequested(() => controller.abort());
  }
  return controller.signal;
}
