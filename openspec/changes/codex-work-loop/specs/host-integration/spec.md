## ADDED Requirements

### Requirement: Codex work loop
The Codex host SHALL ship `hosts/codex/bin/work.mjs`, also the package executable `orchestrator-work`. It SHALL depend only on node built-ins and the orchestrator package, which it finds as the launcher does: a checkout, else the host-local install, else npx at the version pinned in `hosts/codex/package.json`. Starting it from a shell SHALL be the documented primary path, because a background process outliving a Codex turn is unverified.
- It SHALL take `--workers`, `--run-tag` and `--capacity`, and SHALL clamp the worker count to the capacity when one is given, logging the clamp. It SHALL find the daemon by `--url`, `ORCH_URL`, or the run directory of `--repo` (default: the current directory).
- It SHALL run one loop per worker in one process. Each loop SHALL claim over `POST /v1/claims` with `workerId <runTag>-<n>`, `access: "local"` and `runner: "codex"`.
- For each claim the loop SHALL write the shim env file from the claim's `codex.env` and run `codex exec` in the claimed worktree. The command SHALL be composed by `composeCodexCommand(launch, policy)`, exported from `src/runner/codex.ts` and used by the Codex runner too, from the claim's `codex.settings`, `codex.maxWaitMs`, `model` and `effort`. Stdin SHALL be a short preamble followed by the brief. The preamble SHALL name the launch, say that the orchestrator MCP server's tools carry its credentials, say to stop on a 401, and say to retry rather than write a fallback report file. It SHALL carry the claim's `pending` question or answer when there is one.
- After codex exits, the loop SHALL post the usage summed over `turn.completed` lines to `POST /v1/launches/:id/usage` with its worker id. When the launch is still held and running or waiting, the loop SHALL release it: with `keep: true` when codex failed to start (no turn began), and without keep when codex ran but did not report.
- A loop SHALL stop when the run is finished or stalled; or when nothing is claimable for codex (`claimableByKind.codex` is 0), no codex launch is live, and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`. It SHALL also stop after `--max-failures` launches in a row that ended without codex running or reporting.
- While nothing is claimable a loop SHALL long-poll `GET /v1/events` instead of spinning. The poll SHALL be filtered to the `launch.claimable`, `launch.ended` and `launch.released` kinds, so that other loops' claim events do not wake it.
- On SIGINT or SIGTERM the process SHALL terminate its codex processes and release their launches with `keep: true`.
- The Codex host's run skill SHALL document the loop as the way to work a `pull` or `mixed` codex run.

#### Scenario: Two workers drain a graph
- **WHEN** `orchestrator-work --workers 2 --run-tag cx` runs against a three-task `pull` run with `runner.kind: codex`
- **THEN** every launch is claimed by `cx-1` or `cx-2` with `runner: "codex"` and has no pid, every task is done with one trailer commit per task on the integration branch, every launch row carries tokens with `usageSource: "worker"`, and both loops exit once the run is finished

#### Scenario: Codex fails to start
- **WHEN** the loop claims a launch and the `codex` executable exits before any turn starts
- **THEN** the launch is released with `keep: true`, the task returns to `unstarted` at no cost when nothing was touched, and after `--max-failures` such launches the loop stops

#### Scenario: Same command as a spawned launch
- **WHEN** a codex launch is claimed instead of spawned
- **THEN** the `codex exec` command differs from the Codex runner's only in the file fed to stdin

#### Scenario: Workers clamped to capacity
- **WHEN** the loop is started with `--workers 4 --capacity 2`
- **THEN** two loops run and the log says the count was clamped

## MODIFIED Requirements

### Requirement: Codex host
`hosts/codex/` SHALL let a Codex session be the operator. It SHALL ship `bin/orchestrator.mjs`, the dependency-free launcher of "Plugin launcher" resolving its host directory from its own URL, whose npx fallback is pinned to the version of the published package in `hosts/codex/package.json`. It SHALL NOT read `.claude-plugin/plugin.json`. `hosts/codex/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/codex/node_modules` SHALL be ignored by git.

`hosts/codex/config.toml` SHALL be the registration template. It SHALL declare `[mcp_servers.orchestrator_operator]` with `command = "node"`, `args` set to the launcher and `mcp`, `startup_timeout_sec = 30`, and a `tool_timeout_sec` of at least `ceil(WAIT_CAP_MS / 1000) + 30`. The id SHALL use an underscore, so the tools are `mcp__orchestrator_operator__<tool>`.

`hosts/codex/README.md` SHALL document the template block as the primary install. It SHALL document `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/codex>/bin/orchestrator.mjs mcp` as the alternative for a registration that keeps Codex's 60-second default tool timeout. It SHALL document verification with `codex mcp get orchestrator_operator`, and the approval keys `codex exec` needs.

`hosts/codex/skills/` SHALL hold `import`, `run`, and `review` skills, named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`, with the behaviour of "Skills" except as follows. They SHALL NOT reference `${CLAUDE_PLUGIN_ROOT}`. They SHALL have no Workflow or subagent section and SHALL name no Claude model as a default. They SHALL look for the test command in `AGENTS.md`, with `CLAUDE.md` only as the fallback when there is no `AGENTS.md`. Their toolchain line SHALL always name the runner kind. When no daemon is running and `orchestrator.yaml` sets no `runner.mode`, they SHALL call `start` with `mode: "spawn"`, so that the daemon runs the agents headless; otherwise they SHALL call `start` without `mode`, because an explicit mode overrides the file and is applied to a running daemon. When the mode in force is `pull` or `mixed` they SHALL say so, SHALL name the Codex work loop (`orchestrator-work`, "Codex work loop") as the way codex launches are worked in those modes, and SHALL offer `spawn` unless another session holds launches of the run. They SHALL say that under `codex exec` the operator tools run only when approvals are pre-granted (`approval_policy = "never"`, `default_tools_approval_mode = "approve"`, and per-tool `approval_mode = "approve"`), and that an interactive session prompts instead. The `import` skill SHALL name the Codex form of the tracker connectors' tools (`mcp__linear__`, `mcp__atlassian__`).

#### Scenario: operator server registers and its tools answer in a Codex session
- **WHEN** `codex exec` runs with `mcp_servers.orchestrator_operator` set as in `hosts/codex/config.toml` and every operator tool pre-approved, and is asked to start a run, import a graph of scripted tasks, answer its question, and wait
- **THEN** its `mcp_tool_call` items name server `orchestrator_operator`, `start` reports mode `spawn`, and a `wait` result reports `finished: true`

#### Scenario: Registration verified
- **WHEN** the template block is in a Codex config and `codex mcp get orchestrator_operator` is run
- **THEN** it lists the server as enabled over stdio with command `node`, the launcher and `mcp` as args, `startup_timeout_sec: 30`, and a `tool_timeout_sec` above the `wait` cap by at least thirty seconds

#### Scenario: Launcher pinned by the host package
- **WHEN** `hosts/codex` is copied outside any checkout without `node_modules` and its launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp`
- **THEN** it prints source `npx` with `--package=<name>@<the version in hosts/codex/package.json>` and `orchestrator-mcp`

#### Scenario: Test command from AGENTS.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` in a Codex session and `AGENTS.md` says "run tests with `make check`"
- **THEN** the `orchestrator-run` skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `AGENTS.md`
