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
