# Orchestrator MVP

A focused VS Code extension that orchestrates a coding request across your Claude and Codex CLIs.

## Flow

1. You type a prompt in the **Orchestrator** sidebar.
2. The main model (Claude **Opus 4.8** by default) analyses it and splits it into subtasks.
3. The main model recommends a model and effort for each subtask, then a deterministic guardrail validates the choice against the verified catalog:
   - Claude: `haiku`, `sonnet`, `claude-sonnet-4-6`, `opus`, `claude-opus-4-8`
   - Codex: `gpt-5.4-mini`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`
   - Efforts: Claude `low` through `max`; Codex `low` through `ultra` where supported
4. The plan is shown with the model per subtask. Nothing runs yet.
5. You press **Run plan**.
6. Each subtask runs on its assigned model, via the CLI, in dependency order — you watch every command and its output stream live in the sidebar and the "Orchestrator MVP" Output panel.
7. The main model (Opus) combines the pieces into one final result.

### Runtime visibility
The **Live activity** section streams everything as it happens: the usage check for each provider, the exact CLI command being run, the model output token-by-token, quota reroutes, and every file written.

### Files
Generated code files are written **into your open workspace folder** at the paths the models name (like Claude Code). Logs, the plan, and raw per-subtask transcripts go into a `.orchestrator/<timestamp>/` folder. Open a folder in VS Code before running.

### Usage-aware routing
Before planning, the extension reads each CLI's local usage cache (`~/.claude.json`, `~/.codex/sessions`) and shows the headroom. If a provider is out of quota, a subtask routed to it is automatically retried on the other provider so the plan still completes.

## Requirements

- The `claude` CLI, logged in (`claude` → `/login`).
- The `codex` CLI, logged in (`codex login`).

The extension never handles API keys — it uses the logins the CLIs already have.

## Settings

- `orchestratorMvp.mainModel` — the main/orchestrator model (default `claude-opus-4-8`).
- `orchestratorMvp.mainEffort` — effort for the main/orchestrator model (default `high`).
- `orchestratorMvp.claudePath` / `orchestratorMvp.codexPath` — CLI binary paths.
- `orchestratorMvp.timeoutSeconds` — per-subtask timeout.
