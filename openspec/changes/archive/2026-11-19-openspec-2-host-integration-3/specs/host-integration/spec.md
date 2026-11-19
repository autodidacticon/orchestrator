## MODIFIED Requirements

### Requirement: Codex host
`hosts/codex/` SHALL let a Codex session be the operator. It SHALL ship `bin/orchestrator.mjs`, the dependency-free launcher of "Plugin launcher" resolving its host directory from its own URL, whose npx fallback is pinned to the version of the published package in `hosts/codex/package.json`. It SHALL NOT read `.claude-plugin/plugin.json`.

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

#### Scenario: README leads with the plugin
- **WHEN** the host tests read `hosts/codex/README.md`
- **THEN** it names `codex plugin add orchestrator-codex@orchestrator` before the `[mcp_servers.orchestrator_operator]` template block, names `codex plugin remove orchestrator@orchestrator`, and no longer says that Codex has no plugin manifest

### Requirement: Work loop by runner kind
The Codex host SHALL ship `hosts/codex/bin/work.mjs`, also the package executable `orchestrator-work`; it is the work loop of the Codex and OpenCode hosts. It SHALL depend only on node built-ins and the orchestrator package, which it finds as the launcher does: a checkout, else the host-local install, else npx at the version pinned in `hosts/codex/package.json`. Starting it from a shell SHALL be the documented primary path, because a background process outliving an agent turn is unverified.

#### Scenario: Two workers drain a graph
- **WHEN** `orchestrator-work --workers 2 --run-tag cx` runs against a three-task `pull` run with `runner.kind: codex`
- **THEN** every launch is claimed by `cx-1` or `cx-2` with `runner: "codex"` and has no pid, every task is done with one trailer commit per task on the integration branch, every launch row carries tokens with `usageSource: "worker"`, and both loops exit once the run is finished

#### Scenario: A verifying task keeps the loops running
- **WHEN** both loops find nothing claimable and nothing live while T1 is submitted and awaiting its check, and T2, which depends on T1, is not yet admitted
- **THEN** neither loop stops; T2 is claimed once T1 is done, and the loops stop with "the run is finished"

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

#### Scenario: A launch being prepared keeps the loop running
- **WHEN** a `codex` loop finds nothing claimable and nothing live, a question is open, and `status.preparingByKind.codex` is 1
- **THEN** the loop does not stop, also after `--idle-exit-ms`, while an `opencode` loop on the same status stops because the run waits on a human

## ADDED Requirements

### Requirement: Codex host: host package
`hosts/codex/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/codex/node_modules` SHALL be ignored by git.

#### Scenario: Host package checked
- **WHEN** the host tests read `hosts/codex/package.json` and the root `.gitignore`
- **THEN** the package is private, its name is not the published package's, its only dependency is the published package at the exact version the Claude Code plugin pins, and `.gitignore` lists `hosts/codex/node_modules/`

### Requirement: Codex host: installable plugin
`hosts/codex/` SHALL be installable as the Codex plugin of "Codex plugin manifest".

#### Scenario: Plugin manifest read
- **WHEN** the host tests read `hosts/codex/.codex-plugin/plugin.json`
- **THEN** it names `orchestrator-codex` and points `skills` at `./skills/`, `mcpServers` at `./.mcp.json` and `hooks` at `./hooks/hooks.json`

### Requirement: Codex host: registration template
`hosts/codex/config.toml` SHALL be the manual registration template. `hosts/codex/config.toml` SHALL declare `[mcp_servers.orchestrator_operator]` with `command = "node"`, `args` set to the launcher and `mcp`, `startup_timeout_sec = 30`, and a `tool_timeout_sec` of at least `ceil(WAIT_CAP_MS / 1000) + 30`. The id SHALL use an underscore, so the tools are `mcp__orchestrator_operator__<tool>`.

#### Scenario: Template parsed
- **WHEN** the host tests parse `hosts/codex/config.toml`
- **THEN** its `[mcp_servers.orchestrator_operator]` table has `command` `node`, `args` `<hosts/codex>/bin/orchestrator.mjs` and `mcp`, `startup_timeout_sec` 30, and a `tool_timeout_sec` of at least `ceil(WAIT_CAP_MS / 1000) + 30`

### Requirement: Codex host: README plugin install
`hosts/codex/README.md` SHALL lead with the plugin install: `codex plugin marketplace add autodidacticon/orchestrator` and `codex plugin add orchestrator-codex@orchestrator`. `hosts/codex/README.md` SHALL say that the plugin's operator server runs in the plugin root, so the tools take `repo` and the skills pass it, and SHALL document the approval keys `codex exec` needs for a plugin's server, under `plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator`.

#### Scenario: README names the plugin install and its approval keys
- **WHEN** the host tests read `hosts/codex/README.md`
- **THEN** it holds `codex plugin marketplace add autodidacticon/orchestrator`, `codex plugin add orchestrator-codex@orchestrator`, the argument name `repo` and `[plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator]`

### Requirement: Codex host: README removal of the old plugin
`hosts/codex/README.md` SHALL tell users who have `orchestrator@orchestrator` installed in Codex to remove it with `codex plugin remove orchestrator@orchestrator`.

#### Scenario: README names the removal
- **WHEN** the host tests read `hosts/codex/README.md`
- **THEN** it holds `codex plugin remove orchestrator@orchestrator`

### Requirement: Codex host: README manual registration
`hosts/codex/README.md` SHALL keep the template block as the manual alternative, and `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/codex>/bin/orchestrator.mjs mcp` as the alternative for a registration that keeps Codex's 60-second default tool timeout. `hosts/codex/README.md` SHALL document verification with `codex mcp get orchestrator_operator`, and the approval keys `codex exec` needs for a manually registered server.

#### Scenario: README keeps the manual alternatives
- **WHEN** the host tests read `hosts/codex/README.md`
- **THEN** it holds `[mcp_servers.orchestrator_operator]`, `tool_timeout_sec`, `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=`, `codex mcp get orchestrator_operator` and `approval_policy = "never"`

### Requirement: Codex host: skills
`hosts/codex/skills/` SHALL hold `import`, `run`, and `review` skills, named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`, with the behaviour of "Skills" except as follows. The Codex skills SHALL NOT reference `${CLAUDE_PLUGIN_ROOT}`. The Codex skills SHALL have no Workflow or subagent section and SHALL name no Claude model as a default.

#### Scenario: Codex skill editions
- **WHEN** the host tests list `hosts/codex/skills/` and read each `SKILL.md`
- **THEN** the skills are `import`, `review` and `run`, each front matter names `orchestrator-<name>`, and none holds `${CLAUDE_PLUGIN_ROOT}`, a Workflow or subagent heading, or a `claude-opus-`, `claude-sonnet-` or `claude-haiku-` model name

### Requirement: Codex host: skill test command and toolchain
The Codex skills SHALL look for the test command in `AGENTS.md`, with `CLAUDE.md` only as the fallback when there is no `AGENTS.md`. The Codex skills' toolchain line SHALL always name the runner kind.

#### Scenario: CLAUDE.md only beside AGENTS.md
- **WHEN** the host tests read every file under `hosts/codex/` but `node_modules`
- **THEN** each line that names `CLAUDE.md` also names `AGENTS.md`, and the run skill's toolchain line names `config.runnerKind`

### Requirement: Codex host: skills pass repo
The Codex skills SHALL pass `repo` on every operator call, as "Skills pass the repository" defines.

#### Scenario: Each skill says to pass repo
- **WHEN** the host tests read the `import`, `run` and `review` skills of `hosts/codex/skills/`
- **THEN** each holds "Pass `repo`, set to the absolute path of this session's working directory, on every operator tool call."

### Requirement: Codex host: skill start mode
When no daemon is running and `orchestrator.yaml` sets no `runner.mode`, the Codex skills SHALL call `start` with `mode: "spawn"`, so that the daemon runs the agents headless; otherwise they SHALL call `start` without `mode`, because an explicit mode overrides the file and is applied to a running daemon.

#### Scenario: No daemon and no mode in the file
- **WHEN** `status` reports no running daemon and the repository's `orchestrator.yaml` sets no `runner.mode`
- **THEN** the `orchestrator-run` skill calls `start` with `mode: "spawn"`; with `runner.mode` set in the file it calls `start` without `mode`

### Requirement: Codex host: skills in pull or mixed mode
When the mode in force is `pull` or `mixed` the Codex skills SHALL say so, SHALL name the work loop (`orchestrator-work`, "Work loop by runner kind") as the way codex launches are worked in those modes, and SHALL offer `spawn` unless another session holds launches of the run.

#### Scenario: Pull mode offers spawn or the loop
- **WHEN** the mode in force is `pull` and no other session holds launches of the run
- **THEN** the `orchestrator-run` skill says so, shows `modeNote` when it is set, and offers `start` with `mode: "spawn"` or `node <hosts/codex>/bin/work.mjs --workers <n> --run-tag <tag> --capacity <config.capacity>` started from a shell

### Requirement: Codex host: approvals under codex exec
The Codex skills SHALL say that under `codex exec` the operator tools run only when approvals are pre-granted (`approval_policy = "never"`, `default_tools_approval_mode = "approve"`, and per-tool `approval_mode = "approve"`), and that an interactive session prompts instead.

#### Scenario: Approval refusal explained
- **WHEN** an operator tool call comes back refused for approval
- **THEN** the `orchestrator-run` skill tells the user whether the `codex exec` approvals (`approval_policy = "never"`, `default_tools_approval_mode = "approve"`, per-tool `approval_mode = "approve"`) or an interactive session's prompt applies, and stops

### Requirement: Codex host: import skill connectors
The `import` skill SHALL name the Codex form of the tracker connectors' tools (`mcp__linear__`, `mcp__atlassian__`).

#### Scenario: Import skill names the Codex tool prefixes
- **WHEN** the host tests read `hosts/codex/skills/import/SKILL.md`
- **THEN** it holds `mcp__linear__` and `mcp__atlassian__`

### Requirement: Work loop by runner kind: runner flag
The work loop SHALL take `--runner <codex|opencode>`, with `codex` as the default so that an invocation without the flag behaves as before, and SHALL refuse any other kind. `--help` SHALL name the flag and its default.

#### Scenario: Runner kind parsed
- **WHEN** `parseWorkArgs` is given no `--runner`, then `--runner opencode`, then `--runner claude-code`
- **THEN** the kind is `codex`, then `opencode`, and the third call throws naming `codex, opencode`; `--help` prints `--runner <codex|opencode>` and `--runner codex (the default)`

### Requirement: Work loop by runner kind: worker and daemon flags
The work loop SHALL take `--workers`, `--run-tag` and `--capacity`, and SHALL clamp the worker count to the capacity when one is given, logging the clamp. The work loop SHALL take `--max-silence-ms` (see "Work loop ends a hung agent"), and `--help` SHALL name it. The work loop SHALL find the daemon by `--url`, `ORCH_URL`, or the run directory of `--repo` (default: the current directory).

#### Scenario: Daemon found from the run directory
- **WHEN** the work loop is started with neither `--url` nor `ORCH_URL`
- **THEN** it resolves the daemon's URL from the run directory of `--repo`, or of the current directory without `--repo`

### Requirement: Work loop by runner kind: kind adapters
The work loop SHALL find the kind's runner module (`src/runner/<kind>.ts` under tsx in a checkout, else `dist/src/runner/<kind>.js`) and SHALL keep everything that differs by kind in one adapter per kind: the claim's settings block, `prepare` (the shim's inputs and the environment additions), `compose` (the shell command), whether a turn began, `parseUsage` and `classifyFailure`.

#### Scenario: Kind module resolved
- **WHEN** `packageModules('opencode')` and `packageModules()` run in a checkout, under tsx or with a built dist
- **THEN** the first names `runner/opencode.ts` or `runner/opencode.js` and no codex module, and the second names `runner/codex.ts` or `runner/codex.js`

### Requirement: Work loop by runner kind: adapters use the runner modules
Both adapters of the work loop, codex and opencode, SHALL use the functions the runner modules export, so that a claimed launch and a spawned one are composed by the same code.

#### Scenario: Claimed opencode command composed as spawned
- **WHEN** `composeOpenCodeCommand` composes a launch for the loop and for the OpenCode runner
- **THEN** the two commands differ only in the file fed to stdin

### Requirement: Work loop by runner kind: loops in one process
The work loop SHALL run one loop per worker in one process, starting the n-th loop's first claim (n-1)·300 ms late. Each loop SHALL claim over `POST /v1/claims` with `workerId <runTag>-<n>`, `access: "local"` and `runner` set to the chosen kind.

#### Scenario: Staggered claims
- **WHEN** the work loop runs with `--workers 2 --run-tag cx --runner codex`
- **THEN** loop 2 sends its first claim 300 ms after loop 1, and each claim is `POST /v1/claims` with `workerId` `cx-1` or `cx-2`, `access: "local"` and `runner: "codex"`

### Requirement: Work loop by runner kind: codex claim
For a codex claim the loop SHALL write the shim env file from the claim's `codex.env` and run `codex exec` in the claimed worktree, composed by `composeCodexCommand(launch, policy)` from the claim's `codex.settings`, `codex.maxWaitMs`, `model` and `effort`.

#### Scenario: Codex claim prepared
- **WHEN** a codex launch is claimed
- **THEN** the loop writes the shim env file through `writeCodexShimEnv` from `codex.env` and runs the command `composeCodexCommand` returns in the claimed worktree

### Requirement: Work loop by runner kind: opencode config
For an opencode claim the loop SHALL build the per-launch config with `openCodeConfig(opencode.settings, opencode.allowedTools, opencode.maxWaitMs)`, write it through `prepareOpenCodeLaunch` (`.orchestrator/opencode.json`, 0600), and run `opencode run` in the claimed worktree, composed by `composeOpenCodeCommand(launch, policy)` from `opencode.settings`, `model` and `effort`.

#### Scenario: Per-launch opencode config written
- **WHEN** an opencode launch is claimed
- **THEN** `.orchestrator/opencode.json` in the worktree holds the config `openCodeConfig` built, with mode 0600, and the loop runs `opencode run --format json` in the worktree

### Requirement: Work loop by runner kind: opencode environment
The environment of `opencode run` for an opencode claim SHALL carry the claim's `opencode.env` (from which the shim, an MCP child that inherits it, takes `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS` and `ORCH_COMMIT_POLICY`) and the additions `prepareOpenCodeLaunch` returns: `OPENCODE_CONFIG_CONTENT`, and `XDG_DATA_HOME` or `XDG_CONFIG_HOME` when the settings ask for them. No env file is written.

#### Scenario: Shim identity from the environment
- **WHEN** an opencode launch is claimed and `runner.opencode` asks for neither data nor config directory
- **THEN** the `opencode run` environment carries the launch's `ORCH_LAUNCH_ID`, `ORCH_TOKEN` and `ORCH_API` and `OPENCODE_CONFIG_CONTENT`, and no `XDG_DATA_HOME` or `XDG_CONFIG_HOME`

### Requirement: Work loop by runner kind: child environment and prompt file
For a codex or an opencode claim the loop process's own `ORCH_*` variables SHALL be dropped from the child environment. Stdin SHALL be a short preamble followed by the brief, redirected from `.orchestrator/<kind>-work-prompt.md`.

#### Scenario: Loop ORCH variables dropped
- **WHEN** the work loop's own environment holds an `ORCH_*` variable such as `ORCH_URL` and it claims an opencode launch
- **THEN** the `opencode run` environment has no `ORCH_URL`, and its stdin equals `.orchestrator/opencode-work-prompt.md`, which ends with the brief

### Requirement: Work loop by runner kind: preamble
The preamble SHALL name the launch, say that the orchestrator MCP server's tools carry its credentials (for opencode by their names `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox`, `orchestrator_log`), say to stop on a 401, and say to retry rather than write a fallback report file. The preamble SHALL carry the claim's `pending` question or answer when there is one.

#### Scenario: Preamble with a pending question
- **WHEN** `workerPreamble` runs for launch L1 of task T1 with `pending: { seq: 2 }`
- **THEN** the preamble names launch L1 for task T1, the 401 rule, "Never write a fallback report file" and seq 2; with kind `opencode` it names `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log`

### Requirement: Work loop by runner kind: usage after exit
After the agent exits, the loop SHALL post the usage (codex: summed over `turn.completed` lines; opencode: summed over `step_finish` events by `parseOpenCodeUsage`) to `POST /v1/launches/:id/usage` with its worker id.

#### Scenario: OpenCode usage posted by the worker
- **WHEN** a claimed `opencode run` of a loop started with `--run-tag oc` exits after `step_finish` events
- **THEN** the loop posts their summed tokens to `POST /v1/launches/:id/usage` with `workerId` `oc-1`, and the launch row carries them with `usageSource: "worker"`

### Requirement: Work loop by runner kind: release after exit
When the loop did not end the agent itself and the launch is still held and running or waiting, the loop SHALL release it: with `keep: true` when the agent failed to start (codex: no turn began; opencode: no event, that is `exitBeforeTurn` or `startupContended`), and without keep when it ran but did not report. The release reason SHALL name the failure `classifyCodexFailure` or `classifyOpenCodeFailure` gave.

#### Scenario: Ran but did not report
- **WHEN** a claimed agent began a turn and exited without a report while the launch is still held and running
- **THEN** the loop releases the launch without keep, with a reason that names the kind and, when the classifier gave one, the failure

### Requirement: Work loop by runner kind: contended back-off
After a `startupContended` release the loop SHALL wait between 0.5 and 1.5 s before it claims again.

#### Scenario: Back-off after a contended start
- **WHEN** a claimed launch is released after `startupContended`
- **THEN** the loop waits 500 ms plus a random part below 1000 ms before its next claim

### Requirement: Work loop by runner kind: stop rule
A loop SHALL stop when the run is finished or stalled; or when nothing is claimable for its kind (`claimableByKind.<kind>` is 0), nothing is being prepared for it (`preparingByKind.<kind>` is 0; a status without the field counts as 0), no launch of that kind is live, no task is awaiting the verifier (`status.verifying` is empty), and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`.

#### Scenario: Quiet with an open question
- **WHEN** status shows the run neither finished nor stalled, nothing claimable, prepared, live or verifying for `codex`, and an open question
- **THEN** `stopVerdict` stops with "nothing is claimable for codex and the run waits on a human"; without the question it stops once the quiet has lasted `--idle-exit-ms`

### Requirement: Work loop by runner kind: reviews and the stop log
A review in the stop rule of a loop is a node in `awaitingReview` that is not in `verifying`; a submitted task awaiting its check waits on no human, and its result can make a dependent claimable or send the task back for another launch. The log line of a loop that stops SHALL name the kind.

#### Scenario: A verifying task is not a review
- **WHEN** `awaitingReview` lists T1 and `verifying` lists T1, with nothing else claimable or live
- **THEN** `stopVerdict` does not stop; with `awaitingReview` `MVP` and `verifying` empty it stops, and an idle stop of an `opencode` loop logs "nothing claimable for opencode"

### Requirement: Work loop by runner kind: failures in a row
A loop SHALL also stop after `--max-failures` launches in a row that ended without the agent running or reporting; a contended start counts, and so does an agent the loop ended as hung.

#### Scenario: Contended starts count as failures
- **WHEN** `--max-failures` is 3 and three claimed opencode launches in a row end with `startupContended`
- **THEN** the loop logs that 3 launches in a row ended without opencode running or reporting, and stops

### Requirement: Work loop by runner kind: long-poll
While nothing is claimable a loop SHALL long-poll `GET /v1/events` instead of spinning. The poll SHALL be filtered to the `launch.claimable`, `launch.ended` and `launch.released` kinds, so that other loops' claim events do not wake it.

#### Scenario: Filtered wait for events
- **WHEN** a claim finds nothing and the stop rule does not stop the loop
- **THEN** the loop calls `GET /v1/events` with `kinds=launch.claimable,launch.ended,launch.released` and `wait` set to `--poll-ms`

### Requirement: Work loop by runner kind: signals
On SIGINT or SIGTERM the process SHALL end its agents' process groups (SIGTERM, then SIGKILL after a grace period) and release their launches with `keep: true`.

#### Scenario: Stopped while an agent runs
- **WHEN** the work loop gets SIGTERM while a claimed agent runs
- **THEN** it sends SIGTERM to the agent's process group, SIGKILL after 5000 ms, and releases the launch with `keep: true` and the reason "the codex work loop was stopped"

### Requirement: Work loop by runner kind: run skills document the loop
The Codex host's run skill SHALL document the loop as the way to work a `pull` or `mixed` codex run, and the OpenCode host's run skill and README SHALL document `--runner opencode` as the way to work a `pull` or `mixed` opencode run.

#### Scenario: Run skills name the loop
- **WHEN** the Codex run skill, the OpenCode run skill and `hosts/opencode/README.md` are read
- **THEN** the Codex run skill names `orchestrator-work` and `work.mjs` for a `pull` or `mixed` codex run, and the OpenCode run skill and README name `work.mjs --runner opencode`
