# Orchestrator — Project Report

A VS Code extension that plans on Samsung's internal **Gauss** model, executes across **Claude, Codex and Gemini** CLIs, and reports what it saved — while guaranteeing that classified source (bootloader, TEE/Knox, secrets, unreleased plans) never leaves the network.

**Status:** ~9,800 lines across 46 source files, **159 tests passing**, typecheck clean, 181 KB bundle. Not yet run in a live VS Code extension host.

---

## 1. The two problems it solves

1. **Cost.** Developers throw vague prompts at frontier models; the agent explores the repo on its own, burns 40k tokens, and returns the wrong thing. The waste is whole wasted runs, and frontier models doing work a cheap model could do.
2. **Security.** Bootloader, secure boot, TEE/TrustZone/Knox, key material and roadmap material must never reach an external LLM.

The core insight the whole codebase is built on: **these are the same problem.** Everything up to the moment work is dispatched runs on Gauss, and what finally leaves is a compiled, compressed, human-approved payload. Minimising what leaves and reviewing what leaves are the same act.

**Gauss is a plain LLM over HTTP** — no tools, no file access, no agent loop. Every agentic behaviour (walking directories, batching, validating, retrying) is TypeScript in this repo. Gauss is only ever handed text and asked for a judgement.

---

## 2. The pipeline, end to end

```
you type a request (and maybe paste a log)
  │
  0. GUARD     redact identifiers; taint the run if the prose is sensitive   → src/planner/promptGuard.ts, src/policy/redact.ts
  1. SWEEP     regex pass over EVERY file — free, no model call               → src/policy/patterns.ts
  2. CLARIFY   Gauss asks ≤3 questions if the request is vague               → src/planner/intake.ts
  3. SELECT    Gauss picks the ~20 relevant files from skeletons             → src/planner/contextSelector.ts, src/optimize/skeleton.ts
  4. SCAN      Gauss classifies only those files                             → src/planner/scanner.ts
  5. REVIEW    you approve, per file  ← THE GATE                             → src/panel/ReviewPanel.ts, src/policy/approvals.ts
  6. PLAN      compile → decompose → route                                   → src/planner/{compiler,decompose,router}.ts
  7. APPROVE   you approve the plan and model assignments                    → src/panel/PlanPanel.ts
  8. EXECUTE   dispatch to claude -p / codex exec / gemini -p / Gauss        → src/exec/runner.ts, src/exec/adapters/*
       └─ EGRESS CHOKEPOINT re-scans the exact bytes before each send        → src/policy/egress.ts
  9. REPORT    actual spend vs modelled baseline; tamper-evident audit       → src/panel/ReportPanel.ts, src/accounting/baseline.ts, src/audit/log.ts
```

Stages 0–7 are **Gauss-only**. No external provider is contacted until you've approved both the file set and the plan.

---

## 3. Worked example

> **You type:** `@orchestrator my device charging drops fast, please check` and drag in `dumpstate.txt`.

### Stage 0 — GUARD  (`promptGuard.ts`, `redact.ts`)
The dumpstate carries an IMEI, `ro.serialno`, a MAC, a partner email. All are **redacted** to `<IMEI_1>`, `<SERIAL_1>`… reversibly — the model will see placeholders, you'll see the real values back in the results. The prose isn't sensitive, so the run is **not tainted**. If instead you'd typed *"why did project Nightfall slip?"*, redaction can't strip that — the run would be **tainted** and pinned to Gauss for its whole life.
> Chat: *"Removed 4 identifiers (IMEI, device serial, MAC, email) from your message."*

### Stage 1 — SWEEP  (`patterns.ts`)
Regexes scan **all 2,000 files** for free. `bootloader/`, `teegris/`, `knox/`, anything with `avb_verify_slot`/`rollback_index` → **restricted**, excluded from external use entirely. Your charging driver has no hit.
> Chat: *"Swept 2,000 files at no cost. 37 matched a restricted pattern and are excluded."*

### Stage 2 — CLARIFY  (`intake.ts`)
Gauss scores the request ~0.95 ambiguous. **The turn stops** with questions:
> *1. Which board/kernel branch? 2. Is "drops fast" idle drain, load drain, or the percentage jumping? 3. Do you have dmesg/battery-stats? (you attached one)*
> — reply, or say **go** to accept the assumptions.

**This is the single biggest saving.** A wrong 40k-token run is 100% waste; three questions prevent it.

### Stage 3 — SELECT  (`contextSelector.ts`, `skeleton.ts`)
Language-server symbol outlines (zero model cost) are built for eligible files. Gauss picks, with a *mode* per file:
```
max77705_charger.c   → full      "charging current control lives here"
sec_battery.c        → range 2100-2400  "monitor work loop"
sec_charging_common.h→ skeleton  "constants only"
```
Four full files would be ~60k tokens; this selection is ~12k.

### Stage 4 — SCAN  (`scanner.ts`)
Gauss classifies **only those 3 files**, not 2,000. All come back `internal`. Verdicts cached by content hash, so unchanged files are never re-classified.

### Stage 5 — REVIEW  (`ReviewPanel.ts`, `approvals.ts`)
A panel opens, files riskiest-first, **everything unticked**. You tick the three charging files. Bootloader files aren't even selectable. Your decisions are keyed to a **hash of the exact bytes** — edit a file later and its approval goes stale.

### Stage 6 — PLAN  (`compiler.ts`, `decompose.ts`, `router.ts`)
- **Compile** → a `PromptIR`: goal, constraints, acceptance, and **non-goals** ("do not refactor the charging framework") — naming what's out of scope is the cheapest way to stop a model volunteering it.
- **Decompose** → `t1` analyze/hard, `t2` review/standard, `t3` doc/mechanical.
- **Route** (deterministic, no model call): `t1`→claude/opus, `t2`→claude/opus (review is promoted), `t3`→claude/haiku.
- Any file not approved → that subtask is pinned to **Gauss**, no exceptions.

### Stage 7 — APPROVE  (`PlanPanel.ts`)
You see the subtask×model table, the goal/constraints/non-goals, the forecast cost, and how much the prompt compressed. Approve, edit, or reject.

### Stage 8 — EXECUTE  (`runner.ts`, `adapters/*`, `egress.ts`)
Each subtask runs as a one-shot CLI call:
```bash
claude --print --bare --model opus --output-format json --max-turns 1 \
       --permission-mode dontAsk \
       --disallowedTools Bash Read Edit Write Glob Grep WebFetch WebSearch \
       --system-prompt "…" --json-schema '{…}'   < prompt-on-stdin
```
Before every external send, the **egress chokepoint** re-scans the exact serialized bytes and hard-fails on any secret or restricted content — regardless of what routing decided. A **spend cap** stops the run if cost crosses your ceiling; a **circuit breaker** drops an adapter that keeps failing to spawn.

### Stage 9 — RESULTS + REPORT  (`ReportPanel.ts`, `baseline.ts`, `audit/log.ts`)
```
### Results
- ✅ t1 on claude/opus — $0.08, 1.2k out
- ✅ t2 on claude/opus — $0.03, 0.6k out
- ✅ t3 on claude/haiku — $0.00, 0.3k out

### Findings
- Charging current not reduced when temp crosses warm threshold — max77705_charger.c:842
- Monitor work re-arms every 10s regardless of state — sec_battery.c:2213

2 proposed edits. Nothing written to disk.  [Review 2 edits]

### Cost
Actual $0.13 (incl. $0.02 Gauss planning). Modelled baseline $0.60. Net saving $0.47.
```
Findings show `<SERIAL_1>` restored to the real serial. Every stage was written to the **hash-chained audit log**.

### Follow-up — the conversation continues  (`session.ts`)
> **You:** `now check the fuel gauge too`
> *"Follow-up — 1 prior turn, reusing the workspace scan."*
No re-sweep, no re-review of approved files. Gauss plans this **with the prior turn in view**. If turn 1 had been tainted, turn 2 stays on Gauss.

---

## 4. Security model — enforced, not merely intended

| Control | Mechanism | File |
|---|---|---|
| **Planning can't reach an external model** | Test fails the build if `src/planner/**` imports any adapter, the spawner, or a provider SDK | `test/planner-isolation.test.ts` |
| **Chat box is covered** | Structured identifiers redacted (reversibly, Luhn-checked); sensitive prose taints the run | `redact.ts`, `promptGuard.ts` |
| **Two-stage classification** | Regexes over full content catch secrets/boot/TEE every time; Gauss judges only the semantic residual | `patterns.ts`, `scanner.ts` |
| **Human gate** | Per-file approval, nothing pre-ticked, restricted un-approvable by default | `ReviewPanel.ts`, `approvals.ts` |
| **Approvals bound to bytes** | Content-hash keyed; editing a file voids its approval | `approvals.ts` |
| **Fails closed everywhere** | Unscanned/failed/uncertain → restricted or confidential | `scanner.ts` |
| **Deterministic routing** | Policy beats cost; unapproved file → Gauss, auditable rule not a model guess | `router.ts` |
| **Egress chokepoint** | Re-scans the exact outbound bytes; blocks secrets/restricted whatever routing decided | `egress.ts` |
| **CLIs get no file tools** | `--disallowedTools` / `--sandbox read-only` / `--approval-mode plan`; `--add-dir` never passed | `adapters/*` |
| **Tamper-evident audit** | Hash-chained records; salted prompt/response hashes; `verify()` finds the break | `audit/log.ts` |
| **Session taint is sticky** | Conversation-lifetime; a later clean turn can't clear it | `session.ts`, `promptGuard.ts` |

---

## 5. Cost model

**Input side:** clarify-before-running · `claude --bare` (drops CLAUDE.md/hooks/MCP) · tool starvation · skeleton-first context · per-subtask context slices · ledger handoff (summaries not transcripts) · deterministic compression · cache-stable prompt prefix · content-hash scan cache.

**Output side (≈5× input):** schema-constrained replies (no preamble/summary) · search/replace not full rewrites · per-kind token caps · reasoning budget by kind · `file:line` citations instead of quoting · non-goals.

**The savings report is built to survive an audit** (`baseline.ts`): Gauss planning is *inside* the actual total; the uncalibrated exploration multiplier is 1.0 so it *under*-claims; calibration fits from the **median**; a negative saving shows as negative; provider-reported cost is distinguished from table-derived.

---

## 6. Complete file map

### Types & config
| File | Purpose |
|---|---|
| `src/types/ir.ts` | Shared vocabulary: `Tier`, `PromptIR`, `Subtask`, `ExecutionPlan`, `Ledger`, `Usage`, `CostRecord`, `SavingsReport` |
| `src/config.ts` | Settings readers, secret key names |

### Planner — GAUSS ONLY (guarded by a test)
| File | Purpose |
|---|---|
| `src/planner/gauss.ts` | HTTP client; schema-constrained output with 3-way format fallback + repair |
| `src/planner/promptGuard.ts` | Redact + assess the prompt; `SessionTaint` |
| `src/planner/scanner.ts` | Digest builder + batched file classification |
| `src/planner/intake.ts` | Ambiguity scoring, the clarify gate, answer merging |
| `src/planner/contextSelector.ts` | Skeleton → `ContextRef[]` with per-file mode |
| `src/planner/compiler.ts` | → `PromptIR`; `renderIR()` owns cache-prefix ordering |
| `src/planner/decompose.ts` | → subtask DAG, cycle detection, topological waves |
| `src/planner/router.ts` | Deterministic model assignment + `assertRoutingSafe()` |

### Policy
| File | Purpose |
|---|---|
| `src/policy/patterns.ts` | Regex prefilter + entropy, Samsung-tuned defaults |
| `src/policy/redact.ts` | Reversible identifier redaction |
| `src/policy/approvals.ts` | Content-hash-keyed human decisions |
| `src/policy/egress.ts` | The egress chokepoint |

### Optimize
| File | Purpose |
|---|---|
| `src/optimize/skeleton.ts` | LSP symbols → signatures; regex fallback |
| `src/optimize/compress.ts` | License headers, literals, comment-safe stripping |
| `src/optimize/outputPolicy.ts` | Per-kind schema + cap + reasoning budget |
| `src/optimize/tokens.ts` | Heuristic estimator (forecasts only) |

### Exec
| File | Purpose |
|---|---|
| `src/exec/runner.ts` | DAG scheduler; egress + audit + guards wired in |
| `src/exec/ledger.ts` | Artifact handoff between subtasks |
| `src/exec/context.ts` | Materialize refs → text, dedupe, budget |
| `src/exec/process.ts` | Subprocess spawn wrapper (never a shell) |
| `src/exec/breaker.ts` | Spend cap + circuit breaker |
| `src/exec/adapters/types.ts` | `ModelAdapter` interface, capabilities |
| `src/exec/adapters/probe.ts` | CLI capability detection from `--help` |
| `src/exec/adapters/{claude,codex,gemini,gaussAdapter}.ts` | The four adapters |
| `src/exec/adapters/registry.ts` | Probe cache |

### Accounting & audit
| File | Purpose |
|---|---|
| `src/accounting/meter.ts` | Normalize token usage across three CLI output shapes |
| `src/accounting/pricing.ts` | Config-overridable price table |
| `src/accounting/baseline.ts` | Counterfactual + calibration |
| `src/audit/log.ts` | Hash-chained, salted audit log |

### UI & orchestration
| File | Purpose |
|---|---|
| `src/panel/ReviewPanel.ts` | Per-file approval gate |
| `src/panel/PlanPanel.ts` | Execution-plan approval |
| `src/panel/ReportPanel.ts` | Savings report |
| `src/panel/webview.ts` | Shared webview plumbing + CSP |
| `src/session.ts` | The conversation (cross-turn state) — vscode-free |
| `src/pipeline.ts` | Stage orchestration |
| `src/workspace.ts` | All vscode workspace I/O |
| `src/chat/participant.ts` | `@orchestrator` entry point + `/status /report /approvals /audit` |
| `src/extension.ts` | Activation, commands |

---

## 7. What's tested (159 tests)

`accounting` · `probe` · `planner-isolation` (the security invariant) · `security` (prefilter, approvals, routing, taint) · `planner` (scanner, digest, DAG, compression, skeletons, ledger) · `runner` (DAG waves, egress block, spend cap, breaker, audit events) · `redaction` · `egress` · `audit` (chain tamper detection) · `breaker` · `conversation` (cross-turn state, taint persistence).

Tests use a **fake Gauss** and **fake CLI binaries**, so the suite costs zero tokens and needs no vendor reachable.

---

## 8. What is NOT done — ranked by importance

1. **No eval harness.** Nothing measures whether token reduction is costing answer quality. Most likely to kill the project; you wouldn't find out for a quarter.
2. **Never run in a live extension host.** Everything compiles/tests green; the F5 path and `chatContext.history` behaviour are unverified.
3. **Claude & Codex adapters unverified against real binaries** (neither installed here). Gemini probe verified end-to-end against gemini 0.36.0.
4. **Gauss API shape assumed OpenAI-compatible.** The 3-way fallback has never met the real endpoint.
5. **No baseline calibration command** yet (the math exists and is tested).
6. **Redaction catches structured identifiers, not prose** — prose is handled by the coarser taint.
7. **One active conversation at a time**; two chat panels would share state.
8. **Headless CLI auth under enterprise seats unconfirmed** — the one open question that could force execution onto HTTP.

---

## 9. How auth is set up

- **Gauss:** base URL in `orchestrator.gauss.baseUrl`; API key via **Orchestrator: Set Gauss API Key** → VS Code SecretStorage. Never in settings or logs.
- **Claude/Codex/Gemini:** the extension holds **no key** — each CLI authenticates itself. `orchestrator.adapters.env` injects env (e.g. `ANTHROPIC_BASE_URL` for a gateway, or `CLAUDE_CODE_USE_BEDROCK=1`) because a VS Code window launched from Finder doesn't inherit your shell profile.
