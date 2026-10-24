## MODIFIED Requirements

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
