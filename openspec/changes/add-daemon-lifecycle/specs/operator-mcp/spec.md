## MODIFIED Requirements

### Requirement: Operator MCP server
The package SHALL provide `orchestrator-mcp`, a stdio MCP server that exposes operator operations as tools and forwards each to the daemon's HTTP routes. It SHALL never open the store directly. It SHALL resolve the run directory from a `--repo` argument, the `ORCH_REPO` environment variable, or the git top level of its working directory, in that order. Before forwarding any tool other than `start`, `stop`, and `runs` it SHALL revive the daemon on demand as the operator-control specification defines, so that an idle exit or a crash is invisible to the session, and SHALL refuse only after an explicit stop or for a repository with no run directory. On its first successful contact with a daemon, and again whenever the daemon's pid changes, it SHALL register an attachment `{ id, pids }` with its own pid followed by its ancestor chain, walked with `ps -o ppid=` up to six levels within 300 ms; it SHALL send the attachment id in the `x-orch-attachment` header of every request it forwards, SHALL register again when a response carries `x-orch-attachment: unknown` (the operation stands and is not retried) and before forwarding any `claim`, SHALL carry the attachment on every `claim`, and SHALL end the attachment with reason `sessionEnded` when its transport closes or it receives `SIGTERM`, `SIGINT`, or `SIGHUP`, waiting at most half a second. `runs` SHALL include each run's exit record.

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

### Requirement: Start tool
`start` SHALL perform the daemon lifecycle `start` for the resolved run, creating the run directory if needed, and SHALL return the URL, pid, run directory, graph path, and the runner mode in force. It SHALL be safe to call repeatedly. When it spawns the daemon and no `mode` argument is given, it SHALL pass `--default-mode pull`, so that a run started from the plugin executes its launches through session workers unless the repository's `orchestrator.yaml` sets `runner.mode` or the run already holds a mode override. When the daemon is already running and no `mode` is given, the mode SHALL be left as it is.

#### Scenario: Fresh repository
- **WHEN** `start` is called in a repository with no run directory
- **THEN** the run directory is created, a daemon is spawned, the URL answers `status` within the bounded time, and the mode in force is `pull`

#### Scenario: Config wins over the plugin default
- **WHEN** `start` is called without `mode` in a repository whose `orchestrator.yaml` sets `runner.mode: spawn`
- **THEN** the mode in force is `spawn`

#### Scenario: Running daemon keeps its mode
- **WHEN** the daemon runs in `spawn` after `orchestrator-ctl mode spawn` and `start` is called without `mode`
- **THEN** no second daemon is spawned and the mode stays `spawn`

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
