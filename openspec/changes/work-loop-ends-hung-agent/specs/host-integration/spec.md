## MODIFIED Requirements

### Requirement: Work loop by runner kind
The Codex host SHALL ship `hosts/codex/bin/work.mjs`, also the package executable `orchestrator-work`; it is the work loop of the Codex and OpenCode hosts. It SHALL depend only on node built-ins and the orchestrator package, which it finds as the launcher does: a checkout, else the host-local install, else npx at the version pinned in `hosts/codex/package.json`. Starting it from a shell SHALL be the documented primary path, because a background process outliving an agent turn is unverified.
- It SHALL take `--runner <codex|opencode>`, with `codex` as the default so that an invocation without the flag behaves as before, and SHALL refuse any other kind. `--help` SHALL name the flag and its default. It SHALL take `--workers`, `--run-tag` and `--capacity`, and SHALL clamp the worker count to the capacity when one is given, logging the clamp. It SHALL take `--max-silence-ms` (see "Work loop ends a hung agent"), and `--help` SHALL name it. It SHALL find the daemon by `--url`, `ORCH_URL`, or the run directory of `--repo` (default: the current directory).
- It SHALL find the kind's runner module (`src/runner/<kind>.ts` under tsx in a checkout, else `dist/src/runner/<kind>.js`) and SHALL keep everything that differs by kind in one adapter per kind: the claim's settings block, `prepare` (the shim's inputs and the environment additions), `compose` (the shell command), whether a turn began, `parseUsage` and `classifyFailure`. Both adapters SHALL use the functions the runner modules export, so that a claimed launch and a spawned one are composed by the same code.
- It SHALL run one loop per worker in one process, starting the n-th loop's first claim (n-1)·300 ms late. Each loop SHALL claim over `POST /v1/claims` with `workerId <runTag>-<n>`, `access: "local"` and `runner` set to the chosen kind.
- For a codex claim the loop SHALL write the shim env file from the claim's `codex.env` and run `codex exec` in the claimed worktree, composed by `composeCodexCommand(launch, policy)` from the claim's `codex.settings`, `codex.maxWaitMs`, `model` and `effort`.
- For an opencode claim the loop SHALL build the per-launch config with `openCodeConfig(opencode.settings, opencode.allowedTools, opencode.maxWaitMs)`, write it through `prepareOpenCodeLaunch` (`.orchestrator/opencode.json`, 0600), and run `opencode run` in the claimed worktree, composed by `composeOpenCodeCommand(launch, policy)` from `opencode.settings`, `model` and `effort`. The environment SHALL carry the claim's `opencode.env` (from which the shim, an MCP child that inherits it, takes `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS` and `ORCH_COMMIT_POLICY`) and the additions `prepareOpenCodeLaunch` returns: `OPENCODE_CONFIG_CONTENT`, and `XDG_DATA_HOME` or `XDG_CONFIG_HOME` when the settings ask for them. No env file is written.
- Either way the loop process's own `ORCH_*` variables SHALL be dropped from the child environment. Stdin SHALL be a short preamble followed by the brief, redirected from `.orchestrator/<kind>-work-prompt.md`. The preamble SHALL name the launch, say that the orchestrator MCP server's tools carry its credentials (for opencode by their names `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox`, `orchestrator_log`), say to stop on a 401, and say to retry rather than write a fallback report file. It SHALL carry the claim's `pending` question or answer when there is one.
- After the agent exits, the loop SHALL post the usage (codex: summed over `turn.completed` lines; opencode: summed over `step_finish` events by `parseOpenCodeUsage`) to `POST /v1/launches/:id/usage` with its worker id. When the loop did not end the agent itself and the launch is still held and running or waiting, the loop SHALL release it: with `keep: true` when the agent failed to start (codex: no turn began; opencode: no event, that is `exitBeforeTurn` or `startupContended`), and without keep when it ran but did not report. The release reason SHALL name the failure `classifyCodexFailure` or `classifyOpenCodeFailure` gave. After a `startupContended` release the loop SHALL wait between 0.5 and 1.5 s before it claims again.
- A loop SHALL stop when the run is finished or stalled; or when nothing is claimable for its kind (`claimableByKind.<kind>` is 0), no launch of that kind is live, and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`. The log line SHALL name the kind. It SHALL also stop after `--max-failures` launches in a row that ended without the agent running or reporting; a contended start counts, and so does an agent the loop ended as hung.
- While nothing is claimable a loop SHALL long-poll `GET /v1/events` instead of spinning. The poll SHALL be filtered to the `launch.claimable`, `launch.ended` and `launch.released` kinds, so that other loops' claim events do not wake it.
- On SIGINT or SIGTERM the process SHALL end its agents' process groups (SIGTERM, then SIGKILL after a grace period) and release their launches with `keep: true`.
- The Codex host's run skill SHALL document the loop as the way to work a `pull` or `mixed` codex run, and the OpenCode host's run skill and README SHALL document `--runner opencode` as the way to work a `pull` or `mixed` opencode run.

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

#### Scenario: OpenCode launch claimed
- **WHEN** `orchestrator-work --runner opencode` claims a launch of a `pull` run with `runner.kind: opencode`
- **THEN** it runs `opencode run ... < .orchestrator/opencode-work-prompt.md` in the worktree with `OPENCODE_CONFIG_CONTENT` in its environment, whose `mcp.orchestrator.command` is the shim and whose `permission` is `openCodePermission(settings.permission, allowedTools)` for the claim's `allowedTools`, and the launch row carries the usage of the `step_finish` events with `usageSource: "worker"`

#### Scenario: Contended OpenCode start
- **WHEN** the claimed `opencode run` exits with `database is locked` on stderr and no event
- **THEN** the loop logs `startupContended`, releases the launch with `keep: true` so the task returns to `unstarted` with no attempt charged, and claims again after a short back-off

#### Scenario: No launches of the kind
- **WHEN** `orchestrator-work --runner opencode` runs against a daemon whose claimable launches are all `codex`
- **THEN** it leaves them parked and exits once the quiet has lasted `--idle-exit-ms`, logging `nothing claimable for opencode`

## ADDED Requirements

### Requirement: Work loop ends a hung agent
While an agent runs, the work loop SHALL read its launch from `GET /v1/status` every `--poll-ms` and SHALL end the agent's process group (SIGTERM, then SIGKILL after 5 s), logging the reason, when the daemon has ended the launch; when its task reported 30 s ago and the agent has not exited; or when its task is running and the agent has written nothing for longer than the silence limit. Silence SHALL NOT be counted while the task waits on an answer.

#### Scenario: Ended launch
- **WHEN** the worker no longer holds the launch and its task is neither submitted nor done (failed, stuck, lease expired, cancelled, released, or relaunched on another launch)
- **THEN** the loop ends the agent's process group, sending SIGKILL after 5 s even when the shell has already exited

#### Scenario: Daemon unreachable
- **WHEN** `GET /v1/status` fails while the agent runs
- **THEN** only the silence limit applies

#### Scenario: The daemon expires a silent claim
- **WHEN** the claimed agent never writes and never exits, and the daemon fails the launch `leaseExpired` (or `stuck`) and relaunches the task
- **THEN** the loop logs that the daemon ended the launch, ends the agent's process group, and claims the relaunch

#### Scenario: An agent that reported keeps its last output
- **WHEN** the agent submits and the daemon ends the launch `reported` while the agent is still printing its final events
- **THEN** the loop does not end it for 30 s, so its usage is posted with `usageSource: "worker"`

#### Scenario: Waiting is not silence
- **WHEN** the agent is blocked on a question for longer than the silence limit
- **THEN** the loop does not end it

### Requirement: Work loop silence limit
The work loop's silence limit SHALL be `--max-silence-ms` when given, else the claim's `health.stuckFailAfterMs` when the claim carries a positive one, else 45 minutes (the daemon's default `health.stuckFailAfterMs`). `--max-silence-ms 0` SHALL turn it off.

#### Scenario: The claim names no threshold
- **WHEN** the loop runs without `--max-silence-ms` against a daemon whose claim carries no `health`
- **THEN** the silence limit is 45 minutes

#### Scenario: Silence past the limit
- **WHEN** the loop runs with `--max-silence-ms 5000` and the claimed agent writes nothing for longer while its task runs and the launch is still held
- **THEN** the loop ends the agent's process group, releases the launch with `keep: false` and a reason naming the silence, and claims the next launch

### Requirement: Work loop after ending an agent
After an agent the loop ended has exited, the loop SHALL post its usage as for any exit and SHALL NOT classify its output as a start failure. It SHALL release the launch without keep, with a reason naming the termination, when the worker still holds it, and SHALL NOT release a launch the daemon ended. The outcome SHALL be `hung`, counted toward `--max-failures`, except after a report, when it SHALL be `started`. The loop SHALL then claim again.

#### Scenario: The daemon's verdict stands
- **WHEN** the loop ends an agent whose launch the daemon failed `leaseExpired`
- **THEN** no `operator.release` is recorded for that launch and the outcome is `hung`

#### Scenario: A model that always hangs
- **WHEN** `--max-failures` launches in a row end with the outcome `hung`
- **THEN** the loop stops
