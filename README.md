# Orchestrator

A VS Code extension that plans on Gauss, executes across Claude, Codex and Gemini, and reports what it saved.

## What it does

```
you type a request (and maybe paste a log)
  ↓
0. GUARD     redact identifiers from your message; taint the run if the prose
             itself is sensitive                              ← covers the chat box
1. SWEEP     regex pass over EVERY file — free, no model call
2. CLARIFY   Gauss asks up to 3 questions if the request is vague
3. SELECT    Gauss picks the ~20 relevant files from skeletons
4. SCAN      Gauss classifies only those files
5. REVIEW    you decide, per file, what may leave the network  ← the gate
6. PLAN      compile → decompose → route (policy first, cost second)
7. APPROVE   you see the plan and the model assignments
  ↓
8. EXECUTE   dispatched to `claude -p`, `codex exec`, `gemini -p`, or Gauss
9. REPORT    actual spend versus a modelled baseline
```

**Stages 0–7 run entirely on Gauss.** No external provider is contacted until you have approved both the file set and the plan.

The ordering of 1–4 matters more than it looks. Classifying an entire platform tree up front costs hundreds of Gauss calls to produce verdicts for thousands of files a given request will never open. Regexes are free, so they sweep everything; the model only ever judges what the request actually needs. On a kernel tree that is ~20 files instead of ~2,000. Clarification comes before selection because you cannot pick the right files for a request nobody has pinned down.

## Setup

1. Set `orchestrator.gauss.baseUrl` to your internal Gauss endpoint (OpenAI-compatible `/chat/completions`).
2. Run **Orchestrator: Set Gauss API Key** — stored in VS Code SecretStorage, never in settings.
3. Install whichever CLIs you have access to: `claude`, `codex`, `gemini`. Run **Orchestrator: Show Model Adapter Status** to see what was detected.
4. Add your project codenames to `orchestrator.policy.codenames`. This is a cheap, high-precision signal and it is worth keeping current.
5. Type `@orchestrator <your request>` in the Chat view.

Without Gauss configured, nothing runs. That is deliberate — there is no fallback path, because a fallback would defeat the design.

## Security model

**The chat box is covered too.** The file gate covers files; it does not cover the text you type or the dumpstate you paste, which flows into the compiled prompt and from there into every external subtask. Two mechanisms handle it:

- **Redaction** strips structured identifiers — IMEIs (Luhn-checked, so byte counts survive), serials, MACs, emails, tokens, JWTs, private keys. Reversible: the model sees `<IMEI_1>`, you see the real value in the results. The log stays readable, so people keep pasting logs instead of going to a browser tab.
- **Session tainting** handles what redaction cannot touch. "Why did Nightfall slip to Q3?" has no pattern to strip — you either send that sentence or you do not. The whole run pins to Gauss, and the taint is sticky for the conversation, because chat history is resent and a taint that cleared per-turn would leak on the next message.

**The approval gate.** The scan produces a recommendation; a human makes the decision. Nothing is pre-approved, closing the panel approves nothing, and `restricted` files cannot be approved at all unless `orchestrator.policy.allowRestrictedOverride` is on.

**Approvals are bound to content.** Every decision is keyed by a hash of the bytes you reviewed. Edit an approved file and the approval goes stale — approving `payment.ts` and then pasting a key into it does not carry the old decision forward.

**Two-stage classification.** Regexes run over *complete* file content, so secrets, key material, bootloader paths and TEE vocabulary are caught deterministically every time. Only the semantic judgement — unreleased plans, architecture sensitive by context — goes to Gauss, and it sees a bounded sample of each file. That sample is a real limitation, documented in the review panel and adjustable via `orchestrator.scan.digestTokens`.

**Fails closed everywhere.** Unscanned file → restricted. Failed scan batch → restricted. Model returns no verdict → restricted. Model unsure → confidential. Model tries to downgrade what a regex flagged → ignored.

**Enforced, not merely intended.**
- `test/planner-isolation.test.ts` fails the build if anything under `src/planner/` imports an external adapter, the process spawner, or a provider SDK.
- `assertRoutingSafe()` runs immediately before every dispatch and throws rather than warns.
- Executing CLIs are denied file tools (`--disallowedTools`, `--sandbox read-only`, `--approval-mode plan`) and `--add-dir` is deliberately never passed. Context is inlined from approved files only — if a CLI could read the disk itself, the approval gate would be decorative.

## Token optimization

**Input**

| Technique | Mechanism |
|---|---|
| Clarify before running | A wrong 40k-token run is 100% waste. Mandatory gate, not a mode you can skip. |
| Strip agent boilerplate | `claude --bare` + `--system-prompt` full replace |
| Tool starvation | `--max-turns 1`, `--disallowedTools`, read-only sandboxes. Without this the CLI explores and undoes everything upstream. |
| Skeleton-first context | Language-server symbol outlines cost zero model tokens. Bodies only when a subtask must edit. |
| Context slicing | Each subtask gets its own slice, never the union |
| Ledger handoff | Summaries between subtasks, bodies only to declared dependents. Keeps chained context linear, not quadratic. |
| Deterministic compression | License headers, blank lines, long literals — free |
| Cache-stable prefix | `renderIR()` orders static sections first so the provider prompt cache hits across subtasks |
| Scan cache | Verdicts cached by content hash, so unchanged trees are never rescanned |

**Output** (costs roughly 5× input)

| Technique | Mechanism |
|---|---|
| Schema-constrained replies | `--json-schema` / `--output-schema` — removes preamble, restatement, summary |
| Search/replace, not rewrites | Changing 4 lines of a 600-line file costs 4 lines of output |
| Per-kind caps | `outputPolicy.ts`; sub-linear scaling with context so a big prompt cannot uncap output |
| Reasoning by kind | Off for mechanical work, high only for debugging and review |
| Reference, don't quote | `path:line` citations instead of echoing code you already have |
| Non-goals | Naming out-of-scope work is the cheapest way to stop a model volunteering it |

## The savings report

```
Actual   = every call, Gauss planning included    ← exact, provider-reported
Baseline = modelled naive single-frontier run     ← estimate until calibrated
Net      = Baseline − Actual
```

Built to survive an audit rather than to impress:

- **Planning cost is inside the actual total**, never netted out.
- **The uncalibrated exploration multiplier is 1.0** — it assumes a naive run would read exactly the files we selected and no more. That is too generous to the baseline, so an uncalibrated report *understates* the real saving. Under-claiming is the correct failure direction.
- **Calibration fits from the median**, so one run that spidered a monorepo cannot drag the multiplier somewhere indefensible.
- **A negative saving is shown as a negative saving.** Small tasks where planning dominates will show one.
- **Provider-reported cost is distinguished from table-derived cost**, so a stale `orchestrator.pricing` is visible rather than quietly wrong.
- **"Runs avoided by clarification" is a separate line.** It counts runs that never happened — a different kind of claim, and blending it in would produce a headline nobody could check.

## Development

```bash
npm install && npm run build
```

```bash
npm test
```

Tests use a fake Gauss client and fake CLI binaries (shell scripts emitting canned JSON), so the suite costs nothing and does not depend on any vendor being reachable. `npm run watch` plus F5 launches the extension host.

## Layout

```
src/
  planner/     Gauss-only. Guarded by test/planner-isolation.test.ts
    gauss.ts   the only outbound client planning may use
    scanner.ts prefilter + batched classification
    intake.ts  ambiguity scoring and the clarify gate
    compiler.ts → PromptIR
    decompose.ts → subtask DAG
    router.ts  deterministic model assignment
  policy/      patterns.ts (regex prefilter), approvals.ts (the gate)
  optimize/    skeleton, compress, outputPolicy, tokens
  exec/        runner.ts (DAG), ledger.ts, context.ts, adapters/
  accounting/  meter.ts, pricing.ts, baseline.ts
  panel/       review, plan and report webviews
```

## Known gaps

- **Extension activation has not been exercised in a live extension host.** Everything typechecks, builds and unit-tests green; the F5 path is untested.
- **Claude and Codex adapters are unverified against real binaries** — neither CLI was installed on the development machine. The Gemini probe was verified end-to-end against gemini 0.36.0.
- **Whether enterprise seats permit headless CLI invocation is unconfirmed.** This is the one open question that could force execution back onto HTTP.
- **Gauss's API shape is assumed OpenAI-compatible.** The client degrades through `json_schema` → `json_object` → prompt-instructed JSON, but this is untested against the real endpoint.
- **No eval harness yet.** Token reduction that degrades answer quality is a bad trade, and nothing currently measures that. This is the most important gap on the list.
- **Redaction catches structured identifiers, not prose.** An internal design description pasted into chat is handled by tainting, which is coarse — it costs you external models for the whole run. That is the safe direction, but it is not precision.
- **The context selector chooses from skeletons.** If Gauss picks badly, you get a cheaper wrong answer, and nothing currently detects that. See the eval gap above.
