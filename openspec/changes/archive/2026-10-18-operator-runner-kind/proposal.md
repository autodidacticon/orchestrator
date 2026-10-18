## Why

The configuration has had `runner.kind`, a `runner.codex` block, and the per-kind commit policy since `sandbox-and-commit-policy`. The operator surfaces never learned them. In a plugin session the operator cannot select Codex through `start`, `configure`, or `orchestrator-ctl config`. A plugin-started codex run is put in `pull` mode, where no Codex agent is ever spawned and every launch stays parked. The toolchain line names Claude defaults for a Codex run.

## What Changes

- `orchestrator-ctl config` gains `--runner-kind <kind>`, `--sandbox <mode>` (sets `codex.sandbox`), and `--commit <agent|daemon>`. The commit policy is per kind, so `--commit` binds to `--runner-kind` in the same call, else to the kind in force (read from `GET /v1/config`). `--clear` also takes a per-kind key such as `codex.sandbox`. The usage text names both kinds' defaults and says that `ultra` is codex-only. `orchestrator-ctl start --set runnerKind=codex --set codex.model=...` already parses and is now documented. The daemon's `--set` key list names `runnerKind`, `model`, `effort`, and the dotted per-kind keys.
- The MCP `start` and `configure` tools gain `runnerKind`, `sandbox`, `commit`, and `codex: { model, effort }`. The effort enum becomes the union of both kinds' sets. The route still refuses `ultra` for claude-code. `sandbox` and `commit` are folded into the override document by one helper, `foldRunnerArgs`, shared with the CLI.
- The mode default is code, not documentation. A `start` without `mode` whose runner kind is `codex` (the argument, or already in force for the run: the stored override in `config.json`, else `orchestrator.yaml`) passes `--default-mode spawn` instead of `pull`. The result's `modeNote` says so, and it warns when a codex run is in `pull`.
- The `status` tool description names `runnerKind`, the per-launch `runner`, the codex leaves, and `claimableByKind`.
- The run, work, and import skills report the kind in the toolchain line, for example "workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits", and omit the allow-list part for codex. They document `runner.kind`, `runner.codex.*`, and `budgets.prices`. They say that codex launches are worked only in `spawn` or `mixed`, because pull-mode workers are the session's Claude subagents. The run skill does not start the work workflow for a codex-default run.
- The README names the Codex CLI as a prerequisite. Its yaml example shows `runner.kind`, `runner.codex.{model, effort, sandbox}`, and `budgets.prices`. Its cost sentence names both sources.

## Capabilities

### Modified Capabilities
- `operator-control`: Configuration route; Status report: configuration; Start arguments.
- `operator-mcp`: Start tool (mode default for codex); Configure tool.
- `host-integration`: Skills report the toolchain; Skills; Work skill and workflow.
- `worker-runners`: Runner kinds and defaults (the operator surfaces named).

## Impact

- Code: `src/operator/cli.ts`, `src/operator/mcp-server.ts`, `src/runs/resolve.ts` (`foldRunnerArgs`), `src/main.ts` (usage). `src/runs/lifecycle.ts` is unchanged, because it relays overrides generically.
- Docs: `hosts/claude-code/skills/{run,work,import}/SKILL.md`, `README.md`.
- Tests: `test/slice/config.test.ts`, `test/slice/operator-mcp.test.ts`, `test/host/package.test.ts`.
- Drawbacks: more flags and tool parameters. The Claude plugin now documents a fleet it cannot work in pull mode. That is honest, but the two kinds are not symmetric until a Codex host lands.
