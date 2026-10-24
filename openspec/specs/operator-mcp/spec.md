# Operator MCP Specification

## Purpose
The operator MCP server a host session uses to start, drive, wait on, and review a run: a stdio server that forwards every operator operation to the daemon's HTTP routes, the tool set it exposes, the behaviour of the `wait`, `start`, and `review` tools, the `outbox` and `ack` tools through which a session drains tracker-bound effects, the `nudge` tool, the `stuck` and `pausedReason` health fields the `wait` digest carries, the `cascade` parameter of the `reopen` tool, the `proposals`, `accept_proposal`, and `reject_proposal` tools through which a session decides proposed follow-up work, the worker tools (`claim`, `release`, and the token-scoped `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`) through which a session subagent acts as the agent for a claimed launch, and the `mode` argument of `start` that sets the runner mode on a run whether or not it spawned the daemon.

## Requirements

### Requirement: Operator MCP server
The package SHALL provide `orchestrator-mcp`, a stdio MCP server that exposes operator operations as tools and forwards each to the daemon's HTTP routes. It SHALL never open the store directly. Every tool SHALL take an optional `repo` argument, an absolute path inside the session's project, which the server SHALL resolve to the real path of its git top level and SHALL never forward to the daemon; a relative `repo`, or one not inside a git repository, SHALL fail the call with a message saying so. The server SHALL resolve the run directory from the call's `repo`, else the `repo` the session last passed, else a `--repo` argument, the `ORCH_REPO` environment variable, or the git top level of its working directory, in that order. The server SHALL make that choice once per call, before the tool's handler runs, and every request the call forwards SHALL go to the daemon of the repository chosen; because the server handles calls concurrently, a call that names another `repo` while it is in flight SHALL NOT change the daemon it reaches. When none of them yields a repository, the tool SHALL fail with a message naming the `repo` argument rather than resolve to another place, and the `repo` argument's description SHALL say so. Before forwarding any tool other than `start`, `stop`, and `runs` it SHALL revive the daemon on demand as the operator-control specification defines, so that an idle exit or a crash is invisible to the session, and SHALL refuse only after an explicit stop or for a repository with no run directory. On its first successful contact with a daemon, and again whenever that daemon's pid changes, it SHALL register an attachment `{ id, pids }` with its own pid followed by its ancestor chain, walked with `ps -o ppid=` up to six levels within 300 ms; it SHALL send the attachment id in the `x-orch-attachment` header of every request it forwards, SHALL register again when a response carries `x-orch-attachment: unknown` (the operation stands and is not retried) and before forwarding any `claim`, SHALL carry the attachment on every `claim`, and SHALL end the attachment on every daemon it registered with, with reason `sessionEnded`, when its transport closes or it receives `SIGTERM`, `SIGINT`, or `SIGHUP`, waiting at most half a second. `runs` SHALL include each run's exit record.

#### Scenario: Tools forward to routes
- **WHEN** the `answer` tool is called for task T1 with text
- **THEN** the daemon records an operator answer event for T1 and the tool returns the route's response

#### Scenario: Daemon not running
- **WHEN** a tool other than `start`, `runs`, or `status` is called in a repository that has no run directory
- **THEN** the tool returns an error naming the run directory and suggesting `start`

#### Scenario: Revived after idle exit
- **WHEN** the daemon exited idle and `status` is called
- **THEN** the server starts the daemon, the call returns the current status, and `runs` shows the daemon alive

#### Scenario: Refused after stop
- **WHEN** `stop` was called and `status` is called
- **THEN** the tool returns an error naming the stop and suggesting `start`, and no daemon is spawned

#### Scenario: Attachment follows the server
- **WHEN** the server forwards its first `status` call to a daemon
- **THEN** the daemon's `status` lists one attachment whose chain starts with the server's pid, and closing the server's transport removes it within a tick

#### Scenario: Re-attached after /clear
- **WHEN** the session end hook ended the server's attachment and the next `claim` goes through the same server
- **THEN** the server registers a new attachment before forwarding, the claim carries the new id, and `status` lists the new attachment and not the old one

#### Scenario: Re-attached after an unknown flag
- **WHEN** the server forwards `status` after its attachment was ended by the hook
- **THEN** the status is returned, the response carries `x-orch-attachment: unknown`, and the server's next request carries a freshly registered attachment

#### Scenario: Refused without a repository
- **WHEN** the server runs in a directory that is not inside a git repository, with no `--repo` and no `ORCH_REPO`, and `status` is called without `repo`
- **THEN** the tool fails with a message naming the working directory and the `repo` argument

#### Scenario: Repository from the call
- **WHEN** that server is called with `status` and `repo` set to a subdirectory of a repository whose run is loaded
- **THEN** the call returns that run's status

#### Scenario: Repository reused for the session
- **WHEN** a later call on the same server omits `repo`
- **THEN** it is served from the repository the earlier call passed, and `start` returns that repository and its run directory

#### Scenario: Repository never forwarded
- **WHEN** `configure` is called with `capacity` and `repo`
- **THEN** the daemon receives only `capacity` and applies it

#### Scenario: Concurrent calls with different repositories
- **WHEN** a `wait` with `repo` A is in flight and a `status` with `repo` B is called on the same server
- **THEN** the `status` returns B's run, the `wait` returns only A's events, seq and digest, and a later call without `repo` is served from B

### Requirement: Tool set
The server SHALL expose at least `start`, `stop`, `status`, `runs`, `import_issues`, `import_graph`, `wait`, `review`, `answer`, `cancel`, `reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, and `logs`, which form the base set, plus every tool another requirement of this capability adds. Mutating tools SHALL require the same arguments as the corresponding CLI commands. Every tool result SHALL be a single JSON text block. The implementation SHALL keep one list of tool names that the tests compare against the server's advertised tools, so that adding a tool is one change in one place.

#### Scenario: Tool list
- **WHEN** a client lists tools
- **THEN** every tool of the base set is present with an input schema, and every advertised tool is in the implementation's list of names

### Requirement: Wait tool
`wait` SHALL take `afterSeq`, an optional `timeoutMs` defaulting to sixty seconds and capped at ninety seconds so that the call stays under the host's tool-call timeout: Claude Code's foreground limit, Codex's `mcp_servers.<id>.tool_timeout_sec`. It SHALL also take an optional `until` filter of `question`, `review`, `finished`, `stalled`, or `any`. It SHALL return the events since `afterSeq`, the latest sequence number, and the digest. When `until` is set it SHALL return early only when the digest satisfies the filter, otherwise at the timeout. Every poll a `wait` makes SHALL go to the daemon of the repository the call was bound to, for the whole duration of the call.

#### Scenario: Wait for a question
- **WHEN** `wait` is called with `until: question` and an agent blocks ten seconds later
- **THEN** the call returns within eleven seconds with the question in `openQuestions`

#### Scenario: Cap enforced
- **WHEN** `wait` is called with `timeoutMs` of ten minutes
- **THEN** it returns within ninety seconds

#### Scenario: Wait keeps its daemon
- **WHEN** a `wait` with `repo` A has returned from one poll on an event in A, and a call with `repo` B was made before its next poll
- **THEN** the next poll still goes to A's daemon with A's seq, and the `wait` returns A's digest

### Requirement: Start tool
`start` SHALL perform the daemon lifecycle `start` for the resolved run, creating the run directory if needed, and SHALL return the URL, pid, run directory, graph path, and the runner mode in force. It SHALL be safe to call repeatedly. When it spawns the daemon and no `mode` argument is given, it SHALL pass `--default-mode pull`, so that a run started from the plugin executes its launches through session workers unless the repository's `orchestrator.yaml` sets `runner.mode` or the run already holds a mode override. When the runner kind for the start is `codex`, it SHALL pass `--default-mode spawn` instead, because pull-mode workers are the session's Claude subagents and claim only `claude-code` launches. The runner kind for the start is the `runnerKind` argument; without one it is the kind already in force for the run: the run's stored override, as recorded in `config.json`, else `runner.kind` in `orchestrator.yaml`, else `claude-code`. The tool SHALL NOT open the store to find it. When the codex default applied, the result SHALL carry a `modeNote` saying so. When the kind in force after the start is `codex` and the mode in force is `pull`, the `modeNote` SHALL warn that codex launches stay parked. When the daemon is already running and no `mode` is given, the mode SHALL be left as it is. It SHALL accept the optional configuration arguments `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort` (any level of either kind), `codex` (`{ model, effort }`), `sandbox` (the key `codex.sandbox`), and `commit` (the commit policy of `runnerKind`, else of the kind in force) beside `mode`. It SHALL pass them to the lifecycle `start` as one override document and return the `config` block with value and source per key, the `toolchain` record, `needsConfig`, and any `rejected` keys, so that the session can report what was detected and set what was not. Its description SHALL name both kinds' default models.

#### Scenario: Fresh repository
- **WHEN** `start` is called in a repository with no run directory
- **THEN** the run directory is created, a daemon is spawned, the URL answers `status` within the bounded time, and the mode in force is `pull`

#### Scenario: Config wins over the plugin default
- **WHEN** `start` is called without `mode` in a repository whose `orchestrator.yaml` sets `runner.mode: spawn`
- **THEN** the mode in force is `spawn`

#### Scenario: Running daemon keeps its mode
- **WHEN** the daemon runs in `spawn` after `orchestrator-ctl mode spawn` and `start` is called without `mode`
- **THEN** no second daemon is spawned and the mode stays `spawn`

#### Scenario: Detection reported
- **WHEN** `start` is called in a Node repository with no file
- **THEN** the result's `config.checkCommand` is `{ value: "npm test", source: "detected" }` and `needsConfig` is empty

#### Scenario: Check command given at start
- **WHEN** `start` is called with `checkCommand: "make check"` on a running daemon
- **THEN** the tool applies it through the configuration route and the result's `config.checkCommand` has source `argument`

#### Scenario: Effort given at start
- **WHEN** `start` is called with `effort: "high"` on a running daemon
- **THEN** the tool applies it through the configuration route and the result's `config.effort` is `{ value: "high", source: "argument", applied: true }`

#### Scenario: Codex run defaults to spawn
- **WHEN** `start` is called with `runnerKind: "codex"` and no `mode` in a repository with no run directory and no `runner.mode` in its file
- **THEN** the daemon is spawned with `--default-mode spawn`, the result's mode is `spawn`, its `config.runnerKind` is `{ value: "codex", source: "argument" }`, and its `modeNote` names codex and spawn

#### Scenario: Codex in force from the file
- **WHEN** `start` is called without arguments in a repository whose `orchestrator.yaml` sets `runner.kind: codex` and no `runner.mode`
- **THEN** the mode in force is `spawn`

#### Scenario: Claude Code run still defaults to pull
- **WHEN** `start` is called without `mode` and without `runnerKind` in a repository whose run and file name no kind
- **THEN** the mode in force is `pull`

#### Scenario: Codex run in pull is warned about
- **WHEN** `start` is called with `mode: "pull"` on a running daemon whose kind in force is `codex`
- **THEN** the mode becomes `pull` and the result's `modeNote` warns that codex launches stay parked

### Requirement: Review tool
`review` SHALL return the daemon's review bundle for a milestone unchanged, so that the session can judge it or hand it to reviewers before calling `accept` or `reject`.

#### Scenario: Review then accept
- **WHEN** `review` is called for a submitted milestone and then `accept` is called with the returned sha and version
- **THEN** the milestone becomes done

### Requirement: Outbox tools
The server SHALL expose `outbox`, taking optional `after` and `limit` and forwarding to the daemon's `outbox` route, and `ack`, taking an effect `id` and exactly one of `result` or `error`, forwarding to the `ack` route when `result` is given and to the `nack` route when `error` is given. A call with neither or both SHALL return an error without reaching the daemon. Both tools SHALL return the route's response as a single JSON text block.

#### Scenario: Tool list includes the outbox tools
- **WHEN** a client lists tools
- **THEN** `outbox` and `ack` are present with input schemas alongside the base set

#### Scenario: Acknowledge with an error
- **WHEN** `ack` is called with `id` 7 and `error` "rate limited"
- **THEN** the daemon records the rejection for effect 7 and the tool returns the route's response

#### Scenario: Neither result nor error
- **WHEN** `ack` is called with only `id`
- **THEN** the tool returns an error naming the missing argument and nothing is sent to the daemon

### Requirement: Nudge tool
The server SHALL expose `nudge`, taking `task` and `message`, forwarding to the nudge route and returning its response as a single JSON text block, in addition to the tools listed under the tool set.

#### Scenario: Nudge through the tool
- **WHEN** the `nudge` tool is called for running task T2 with a message
- **THEN** the daemon records the operator nudge event and T2's launch holds the notice

#### Scenario: Tool list includes nudge
- **WHEN** a client lists tools
- **THEN** `nudge` is present with an input schema requiring `task` and `message`

### Requirement: Wait digest: health fields
The digest returned by `wait` and `events` SHALL include `stuck` and `pausedReason`. Because flagging, unflagging, and budget pauses are recorded as events, `wait` with `until: any` SHALL return when they change. The `resume` tool SHALL accept `overrideBudget`.

#### Scenario: Wait returns on a stuck flag
- **WHEN** `wait` is called with `until: any` and a launch is flagged stuck ten seconds later
- **THEN** the call returns within eleven seconds with the task in the digest's `stuck`

#### Scenario: Digest shows a budget pause
- **WHEN** the run cost budget is reached during a `wait`
- **THEN** the returned digest has `paused` true and `pausedReason` `costBudget`

### Requirement: Reopen tool cascade parameter
The `reopen` tool SHALL accept an optional boolean `cascade`, forward it in the route body, and return the route's response unchanged, so that a refusal carries `blockers` and a cascade carries `reset`.

#### Scenario: Refusal then cascade
- **WHEN** `reopen` is called for T1 while T2 runs, and then called again with `cascade: true`
- **THEN** the first result carries `blockers` with T2 and the second carries `reset` with T1 and T2

### Requirement: Proposal tools
The server SHALL expose `proposals` with an optional `status`, `accept_proposal` with `id`, optional `nodeId`, and optional `payload`, and `reject_proposal` with `id` and `note`, each forwarding to the corresponding daemon route and returning a single JSON text block.

#### Scenario: Accept through the tool
- **WHEN** `accept_proposal` is called with `T2-p1` and `nodeId` ENG-77
- **THEN** the daemon records the operator event, the result reports node ENG-77, and `status` no longer lists `T2-p1`

### Requirement: Worker tools
The server SHALL additionally expose `claim` with `{ workerId, taskId?, access? }`, forwarding its attachment in the body, `release` with `{ launchId, reason, keep? }`, and the token-scoped tools `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`, each taking `{ launchId, token, ...body }` and forwarding to the agent API route of the same name with the token as the bearer, so that a session subagent, which cannot run the per-agent MCP shim, can act as the agent. `launch_block` SHALL stay a foreground call: it SHALL return the daemon's response when it arrives within at most ninety seconds and otherwise `{ pending: true, seq }`; the worker SHALL call it again with the same seq, and the daemon's replay rules SHALL return the answer once admitted. `start` SHALL accept an optional `mode` of `spawn`, `pull`, or `mixed` and apply it to the run whether or not it spawned the daemon.

#### Scenario: Claim through the tool
- **WHEN** `claim` is called with worker id `w1` while T1 is parked
- **THEN** the result carries T1's launch id, token, worktree, brief path, brief, base sha, and API URL, `status` lists `w1` under `workers`, and the launch's worker record carries the server's attachment

#### Scenario: Block stays in the foreground
- **WHEN** `launch_block` is called with seq 1 and no answer arrives for two minutes
- **THEN** the call returns `{ pending: true }` within ninety seconds, and a second call with seq 1 after the operator answers returns `{ answer }`

#### Scenario: Start sets the mode on a running daemon
- **WHEN** `start` is called with mode `pull` while the daemon is already running in `spawn` mode
- **THEN** no second daemon is spawned and `status` reports mode `pull`

#### Scenario: Release with keep through the tool
- **WHEN** `release` is called with `keep` true for a launch with commits
- **THEN** the route receives `keep` true and the result reports `kept` true with the branch and head sha

### Requirement: Configure tool
The server SHALL expose `configure`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort` (any level of either kind; the route refuses a level the kind lacks), `codex` (`{ model, effort }`), `sandbox` (the key `codex.sandbox`), and `commit` (the commit policy of `runnerKind` in the same call, else of the kind in force on the daemon), each a value or null to clear. It SHALL fold `sandbox` and `commit` into the per-kind blocks, forward to `PUT /v1/config`, and return the route's response as a single JSON text block, including a 400 or 409 unchanged. Its description SHALL name both kinds' defaults and SHALL say that `ultra` is codex-only. The `status` tool description SHALL mention the `config`, `toolchain`, and `needsConfig` facts, `runnerKind`, the codex leaves, `claimableByKind`, and the per-launch `runner`, `model`, and `effort`, and the `wait` tool description SHALL mention `needsConfig` in the digest.

#### Scenario: Tool list includes configure
- **WHEN** a client lists tools
- **THEN** `configure` is present with an input schema whose properties are `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `codex`, `sandbox`, and `commit`, all optional

#### Scenario: Set the check command through the tool
- **WHEN** `configure` is called with `checkCommand: "npm test"` while it was unresolved
- **THEN** the daemon records the operator event, the result lists `checkCommand` under `applied`, and the next `wait` digest has an empty `needsConfig`

#### Scenario: Refusal passes through
- **WHEN** `configure` is called with `capacity: 0`
- **THEN** the result carries status 400 naming `capacity` and `isError` is true

#### Scenario: Set the model through the tool
- **WHEN** `configure` is called with `model: "claude-sonnet-5-5"`
- **THEN** the result lists `model` under `applied` and the next launch prepared has that model

#### Scenario: Commit policy through the tool
- **WHEN** the kind in force is `codex` and `configure` is called with `commit: "agent"`
- **THEN** the result's `config.codex.commit` is `{ value: "agent", source: "argument" }` and `config.claude.commit` is unchanged

#### Scenario: Ultra refused for Claude Code through the tool
- **WHEN** `configure` is called with `runnerKind: "claude-code"` and `effort: "ultra"`
- **THEN** the result carries status 400 naming `effort` and `isError` is true
