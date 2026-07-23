# Orchestrator — brief for an AI coding agent

Paste this whole file as your opening message to Codex, Gemini, Claude Code, or any agent you point at this repo. It gives the agent the design intent, the invariants it must not break, and where things live — so it changes the right file for the right reason.

---

## What this project is

A VS Code extension for an enterprise (Samsung) that has Claude, GPT/Codex and Gemini access plus an internal LLM called **Gauss**. It solves two problems at once:

1. **Cost.** Developers throw vague prompts at frontier models, the agent explores the repo on its own, burns 40k tokens, and returns something they didn't want.
2. **Security.** Bootloader, secure boot, TEE/TrustZone/Knox, key material and unreleased roadmap material must never leave the company network.

The central insight the codebase is built around: **these are the same problem.** Everything up to the moment work is dispatched runs on Gauss, and what finally leaves is a compiled, compressed, human-approved payload. Reviewing what leaves and minimising what leaves are the same act.

**Gauss is a plain LLM over HTTP.** No tools, no file access, no agent loop. Every agentic behaviour — walking directories, batching, validating, retrying — is TypeScript in this repo. Gauss is only ever handed text and asked for a judgement. Do not "give Gauss tools"; that is not what it is.

---

## Pipeline

```
0. GUARD     redact identifiers from the user's message; taint the run if the
             prose itself is sensitive                    ← covers the chat box
1. SWEEP     regex pass over EVERY file — free, no model call
2. CLARIFY   Gauss asks ≤3 questions if the request is vague; the turn ENDS here
3. SELECT    Gauss picks the ~20 relevant files from skeletons
4. SCAN      Gauss classifies only those files
5. REVIEW    human approves, per file                     ← the gate
6. PLAN      compile → decompose → route
7. APPROVE   human approves the plan
8. EXECUTE   dispatch to `claude -p` / `codex exec` / `gemini -p` / Gauss
9. REPORT    actual spend (planning included) vs modelled baseline
```

Stages 0–7 are Gauss-only. The ordering of 1–4 is deliberate and was a fix: classifying a whole platform tree up front costs hundreds of Gauss calls for files the request never opens. Regexes are free so they sweep everything; the model only judges what the request needs. Clarification precedes selection because you cannot pick files for a request nobody has pinned down.

---

## Invariants — do not break these

Each of these has a test. If your change makes a test fail, the invariant is right and the change is wrong, unless you can argue otherwise explicitly.

**I1 — `src/planner/**` must never import an external model path.**
Enforced by `test/planner-isolation.test.ts`, which forbids `adapters/{claude,codex,gemini}`, `exec/process`, and provider SDKs. The planner sees raw prompts and raw workspace content before anything is classified or reviewed. An accidental import is not something code review reliably catches, so it is a test.

**I2 — Everything fails closed.**
Unscanned file → `restricted`. Failed scan batch → `restricted`. Model returns no verdict for a file → `restricted`. Model says "unsure" → `confidential`. Model tries to downgrade what a regex flagged → ignored. Never invert any of these to "assume safe".

**I3 — Approvals are keyed by content hash, not path.**
Edit an approved file and the approval goes stale. `ApprovalStore.route()` in `src/policy/approvals.ts`. Do not add a path-only lookup path.

**I4 — Routing precedence is strict, and policy always beats cost.**
```
0. session tainted            → Gauss  (prompt itself is sensitive)
1. any unapproved file        → Gauss
2. difficulty + kind          → cost tier
3. first available adapter in that tier
4. nothing available          → Gauss, with a warning
```
`src/planner/router.ts`. Rules 0 and 1 are not negotiable for cost reasons.

**I5 — `assertRoutingSafe()` runs immediately before every dispatch and throws.**
Redundant with the router by design. Bytes that reach a provider cannot be recalled, so the cheap redundant check stays.

**I5b — The egress chokepoint re-scans the serialized payload.**
`src/policy/egress.ts`. Every non-Gauss dispatch passes through `EgressGuard.inspect()` with the exact bytes about to be sent, which re-runs the deterministic secret + tier scan and hard-fails on a raw secret, confidential-tier content, or a surviving redaction placeholder — regardless of what routing decided. This is the structural backstop the reviewer asked for: routing is a decision and decisions have bugs; the chokepoint reads what actually leaves. It only ever blocks; it cannot approve what upstream denied. Do not route dispatch around it, and do not weaken it to a warning.

**I6 — Executing CLIs get no file tools.**
`--disallowedTools` / `--sandbox read-only` / `--approval-mode plan`, `--max-turns 1`, and **`--add-dir` is deliberately never passed**. Context is inlined from approved files only. If a CLI could read the disk itself it could pull in a Gauss-only file and the approval gate would be decorative. This is a security control, not just a token optimization — do not "helpfully" re-enable tools to improve answers.

**I7 — The savings report must stay auditable.**
Gauss planning cost is inside the actual total, never netted out. The uncalibrated exploration multiplier is `1.0`, which under-claims deliberately. Calibration fits from the **median**. Negative savings display as negative. Provider-reported cost is distinguished from table-derived. Do not "improve" any of these in a direction that flatters the number.

**I8 — `renderIR()` owns prompt ordering.**
Static sections first (goal → constraints → acceptance → non-goals), variable tail last, so the provider prompt cache sees a stable prefix across subtasks of one plan. Reordering it silently costs cache hits. It is the only place the layout is decided; keep it that way.

---

## Where things live

| Concern | File |
|---|---|
| Shared types (`Tier`, `PromptIR`, `Subtask`, `Usage`, …) | `src/types/ir.ts` |
| Gauss HTTP client, JSON extraction, format fallback | `src/planner/gauss.ts` |
| Redaction + session tainting | `src/planner/promptGuard.ts`, `src/policy/redact.ts` |
| Regex prefilter, entropy, codenames | `src/policy/patterns.ts` |
| File classification (digest + batching) | `src/planner/scanner.ts` |
| Human approvals | `src/policy/approvals.ts` |
| Clarify gate | `src/planner/intake.ts` |
| Context selection (skeleton / range / full) | `src/planner/contextSelector.ts` |
| Prompt compilation → `PromptIR`, `renderIR()` | `src/planner/compiler.ts` |
| Subtask DAG, cycle detection, waves | `src/planner/decompose.ts` |
| Model routing | `src/planner/router.ts` |
| Output schemas, caps, reasoning budget | `src/optimize/outputPolicy.ts` |
| Skeletons (LSP + regex fallback) | `src/optimize/skeleton.ts` |
| Deterministic compression | `src/optimize/compress.ts` |
| DAG executor | `src/exec/runner.ts` |
| Subtask handoff | `src/exec/ledger.ts` |
| Context materialization | `src/exec/context.ts` |
| Egress chokepoint | `src/policy/egress.ts` |
| Hash-chained audit log | `src/audit/log.ts` |
| Spend cap + circuit breaker | `src/exec/breaker.ts` |
| CLI adapters | `src/exec/adapters/{claude,codex,gemini,gaussAdapter}.ts` |
| CLI capability probe | `src/exec/adapters/probe.ts` |
| Token metering per provider | `src/accounting/meter.ts` |
| Price table | `src/accounting/pricing.ts` |
| Counterfactual + calibration | `src/accounting/baseline.ts` |
| Webviews | `src/panel/{ReviewPanel,PlanPanel,ReportPanel,webview}.ts` |
| Stage orchestration | `src/pipeline.ts` |
| All vscode workspace I/O | `src/workspace.ts` |
| Chat entry point | `src/chat/participant.ts` |
| Settings + secret key name | `src/config.ts`, `package.json` |

---

## How auth works — read before touching it

**Gauss:** base URL in settings (`orchestrator.gauss.baseUrl`), API key in VS Code **SecretStorage** under `orchestrator.gauss.apiKey`. Written by the `orchestrator.setGaussApiKey` command, read in `Pipeline.gauss()`, sent as `Authorization: Bearer` in `GaussClient.post()`. The key is never written to settings, logs, or disk by this extension. Do not move it into `settings.json`.

**Claude / Codex / Gemini:** this extension **holds no key for them and must never be given one.** It spawns their CLIs; each CLI authenticates itself through its own login, keychain, or environment. The extension passes `{ ...process.env, ...adapterEnv() }` to the child, where `adapterEnv()` reads `orchestrator.adapters.env`. That setting exists because a VS Code window launched from Finder or the Dock does not inherit the shell profile, so a key exported in `.zshrc` is simply absent and the CLI fails with an auth error that looks like an extension bug.

If you are asked to "add API key settings for Claude/OpenAI/Gemini", push back: the correct answer is either the CLI's own auth, or `orchestrator.adapters.env` pointing at a gateway (`ANTHROPIC_BASE_URL`) or a cloud provider (`CLAUDE_CODE_USE_BEDROCK=1`).

---

## Build, test, run

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test, no build step
npm run build         # esbuild → dist/extension.cjs
npm run watch         # then F5 in VS Code to launch the extension host
```

Conventions worth knowing before you write code:

- **TypeScript parameter properties are banned.** Node's type stripping runs the tests with no build step and does not support them. Write `private readonly x: T;` plus an explicit assignment in the constructor. If you add `constructor(private readonly x: T)` the whole suite fails to load.
- Relative imports carry the `.ts` extension. The package is ESM; the bundle is emitted as `.cjs` because the extension host loads CommonJS.
- `strict` plus `noUncheckedIndexedAccess` are on. Array indexing yields `T | undefined`.
- Tests never call a real model or a real CLI. Gauss is faked with a structural stub; CLIs are faked with shell scripts that print canned JSON. **Keep it that way** — a test suite that costs tokens will stop being run.

---

## Deliberate design choices you might mistake for bugs

- **Comment stripping is off by default** in `compress.ts`. Comments carry intent; stripping them yields a shorter prompt and a worse answer.
- **Estimated output is 60% of the cap**, not the cap, in `router.ts`. Quoting the ceiling makes every plan look more expensive than it is and pushes people to skip the tool.
- **A failed classification is not cached.** Caching it would permanently quarantine a file nobody ever looked at.
- **Redaction runs before the prefilter**, and the prefilter sees the redacted text. Otherwise every run that pasted a log would taint, people would stop pasting logs, and they would paste them into a browser tab instead.
- **Session taint is one-way.** A clean later turn does not clear it, because chat history is resent.
- **The runner never auto-retries.** A subtask that failed on a frontier model usually fails the same way again, and silent retries are how a cost-saving orchestrator triples the bill.
- **The runner never continues past a failed dependency.** Feeding a downstream subtask the absence of its input produces confident nonsense.

---

## Known gaps — good places to contribute

Ranked by how much they matter.

1. **No eval harness.** Nothing measures whether token reduction is costing answer quality. This is the gap most likely to kill the project: you would not find out for a quarter. Wanted: 30–50 real tasks, run through both the orchestrated and a naive single-frontier-model path, compared on task success rate rather than tokens.
2. **Extension activation has never run in a live extension host.** Typecheck, build and unit tests are green; the F5 path is untested.
3. **Claude and Codex adapters are unverified against real binaries.** Neither CLI was installed on the development machine. The Gemini probe was verified end-to-end against gemini 0.36.0. Flags were taken from current vendor docs — see `PROBE_SPECS` in `probe.ts` for what is assumed.
4. **Gauss's API shape is assumed OpenAI-compatible.** `GaussClient` degrades `json_schema` → `json_object` → prompt-instructed JSON, but that chain has never met the real endpoint.
5. **No baseline calibration command.** `fitCalibration()` and `shouldSampleBaseline()` exist and are tested; nothing calls them yet. Needs a command that runs the naive path on a sample and stores a `CalibrationSample`.
6. **Redaction catches structured identifiers, not prose.** Internal design prose pasted into chat is handled by tainting, which costs external models for the whole run. Safe, but coarse.
7. **Whether enterprise seats permit headless CLI invocation is unconfirmed.** The one open question that could force execution back onto HTTP.

---

## How to work in this repo

1. Read `README.md` and this file first. Then read `src/types/ir.ts` — it is the vocabulary everything else uses.
2. Before changing anything under `src/planner/` or `src/policy/`, read the invariants above. Those two directories are the security surface.
3. Run `npm run typecheck && npm test` before and after. All 120 tests pass on a clean tree; if any fail before your change, say so rather than working around it.
4. Add a test for behaviour you change. The existing tests are written to state *why* a behaviour exists, not just that it holds — match that.
5. Match the surrounding comment style: explain the non-obvious reason, not the mechanics. `// increment i` is noise; `// Prefilter the REDACTED text, because …` is the house style.
6. If you think an invariant is wrong, say so explicitly and explain why. Do not quietly route around it.

---

## Task

<!-- Replace this section with what you actually want done. Examples: -->

> Build the eval harness described in gap 1. Add `eval/tasks/*.json` fixtures and an `npm run eval` script that runs each task through both paths and reports success rate and cost per task. Do not call real models in `npm test`; the eval script is separate and may.

> Add the baseline calibration command from gap 5: `orchestrator.calibrateBaseline` runs the naive single-frontier path on the last completed plan, stores a `CalibrationSample` in `globalState` under `orchestrator.calibration.v1`, and reports the refitted multiplier. It costs real tokens, so confirm with the user before running.

> Verify the Claude and Codex adapters against the real CLIs (gap 3). Install both, run a trivial subtask through each, and correct any flag or output-shape assumption that turns out to be wrong. Report what differed from `PROBE_SPECS` and the meter parsers.
