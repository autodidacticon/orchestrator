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
- A loop SHALL stop when the run is finished or stalled; or when nothing is claimable for its kind (`claimableByKind.<kind>` is 0), nothing is being prepared for it (`preparingByKind.<kind>` is 0; a status without the field counts as 0), no launch of that kind is live, no task is awaiting the verifier (`status.verifying` is empty), and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`. A review is a node in `awaitingReview` that is not in `verifying`; a submitted task awaiting its check waits on no human, and its result can make a dependent claimable or send the task back for another launch. The log line SHALL name the kind. It SHALL also stop after `--max-failures` launches in a row that ended without the agent running or reporting; a contended start counts, and so does an agent the loop ended as hung.
- While nothing is claimable a loop SHALL long-poll `GET /v1/events` instead of spinning. The poll SHALL be filtered to the `launch.claimable`, `launch.ended` and `launch.released` kinds, so that other loops' claim events do not wake it.
- On SIGINT or SIGTERM the process SHALL end its agents' process groups (SIGTERM, then SIGKILL after a grace period) and release their launches with `keep: true`.
- The Codex host's run skill SHALL document the loop as the way to work a `pull` or `mixed` codex run, and the OpenCode host's run skill and README SHALL document `--runner opencode` as the way to work a `pull` or `mixed` opencode run.

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

### Requirement: Work skill and workflow
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable and nothing being prepared (`claimable` and `preparing` are 0). The skill SHALL say that pull-mode workers are this session's Claude subagents, which claim only `claude-code` launches, so that codex launches are worked only in `spawn` or `mixed`; when only codex launches are parked it SHALL offer `start` with `mode: "spawn"` or `"mixed"` instead of running the workflow. The workflow SHALL claim with `runner: "claude-code"`, so that codex-kind launches are never claimed by the Claude worker loop, and its stop rule SHALL count only `claimableByKind["claude-code"]` and `preparingByKind["claude-code"]` (0 when the status has no `preparingByKind`). The workflow SHALL clamp the worker count to the `capacity` argument when one is given, logging the clamp, and SHALL fan out one loop per worker with `parallel`. Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, read `status`, evaluate the stop rule, and claim again, up to three polls before returning without a launch. On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. A loop SHALL end when nothing is claimable, nothing is being prepared for `claude-code`, no loop holds a launch, and the digest reports finished, stalled, or an open question. Workflow results SHALL be short outcomes, never briefs or logs. The `work` and `run` skills SHALL document `claimModel` and `claimEffort` with their defaults and pass them only when the user asks for a different claimer, and SHALL say that workers edit worktrees under the run directory, outside the repository, so a session in `acceptEdits` mode prompts for each file there unless started with `--add-dir` for that directory.

#### Scenario: Two workers drain a graph
- **WHEN** the work skill runs with two workers on a three-task graph in `pull` mode
- **THEN** every task is claimed, worked, and submitted by a worker, the integration branch gains one trailer commit per task, and the workflow returns when the run is finished

#### Scenario: Question ends the loop and a re-run resumes it
- **WHEN** a worker asks a question nobody answers and nothing else is claimable
- **THEN** the workflow returns with the question in the digest, the skill answers it through the user, and the re-run worker with the same id receives the answer through `launch_block`

#### Scenario: Worker agent runs with the claimed selection
- **WHEN** a loop claims a launch whose response carries `model: "claude-sonnet-5-5"` and `effort: "low"`
- **THEN** the worker agent for that launch is started with model `claude-sonnet-5-5` and effort `low`

#### Scenario: Claimer runs cheap by default
- **WHEN** the workflow runs without `claimModel` or `claimEffort`
- **THEN** every claimer agent is started with model `claude-haiku-5-5` and effort `low`, and a run with `claimModel: "claude-sonnet-5-5"` starts them with that model instead

#### Scenario: Idle loop polls inside one claimer
- **WHEN** nothing is claimable and the stop rule does not hold
- **THEN** one claimer agent waits, reads status, and claims again up to three times before returning, and a launch parked during a wait is claimed on the next poll of the same agent

#### Scenario: Labels share the worker id
- **WHEN** worker `work-1-2` claims KNO-10
- **THEN** the view shows an agent labelled `claim work-1-2` followed by one labelled `work work-1-2 KNO-10`

#### Scenario: Worktrees outside the repository need an allowed directory
- **WHEN** a headless session in `acceptEdits` mode runs the workflow with `--add-dir` naming `ORCH_HOME`
- **THEN** its workers edit and commit in the worktrees without a permission prompt, and without that flag the first edit is refused

#### Scenario: Workers clamped to capacity
- **WHEN** the workflow is run with `workers: 6` and `capacity: 2`
- **THEN** two loops run and the log says the count was clamped

#### Scenario: Codex launches are not claimed by the Claude worker loop
- **WHEN** a mixed-mode run holds a parked `codex` launch and a parked `claude-code` launch and the workflow runs
- **THEN** a worker claims the `claude-code` launch only, the `codex` launch stays parked until the claim window passes and the daemon spawns it, and the loop's stop rule counts only `claimableByKind["claude-code"]`

#### Scenario: A launch being prepared keeps the claimer polling
- **WHEN** nothing is claimable for `claude-code`, a question is open, and `status.preparingByKind["claude-code"]` is 1 because a launch's prepare command runs
- **THEN** the claimer's stop is false and it polls again; a status without `preparingByKind` is read as 0
