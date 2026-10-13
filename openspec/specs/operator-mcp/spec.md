# Operator MCP Specification

## Purpose
The operator MCP server a host session uses to start, drive, wait on, and review a run: a stdio server that forwards every operator operation to the daemon's HTTP routes, the tool set it exposes, the behaviour of the `wait`, `start`, and `review` tools, the `outbox` and `ack` tools through which a session drains tracker-bound effects, the `nudge` tool, and the `stuck` and `pausedReason` health fields the `wait` digest carries.

## Requirements

### Requirement: Operator MCP server
The package SHALL provide `orchestrator-mcp`, a stdio MCP server that exposes operator operations as tools and forwards each to the daemon's HTTP routes. It SHALL never open the store directly. It SHALL resolve the run directory from a `--repo` argument, the `ORCH_REPO` environment variable, or the git top level of its working directory, in that order.

#### Scenario: Tools forward to routes
- **WHEN** the `answer` tool is called for task T1 with text
- **THEN** the daemon records an operator answer event for T1 and the tool returns the route's response

#### Scenario: Daemon not running
- **WHEN** a tool other than `start`, `runs`, or `status` is called and no daemon answers
- **THEN** the tool returns an error naming the run directory and suggesting `start`

### Requirement: Tool set
The server SHALL expose at least `start`, `stop`, `status`, `runs`, `import_issues`, `import_graph`, `wait`, `review`, `answer`, `cancel`, `reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, and `logs`, which form the base set, plus every tool another requirement of this capability adds. Mutating tools SHALL require the same arguments as the corresponding CLI commands. Every tool result SHALL be a single JSON text block. The implementation SHALL keep one list of tool names that the tests compare against the server's advertised tools, so that adding a tool is one change in one place.

#### Scenario: Tool list
- **WHEN** a client lists tools
- **THEN** every tool of the base set is present with an input schema, and every advertised tool is in the implementation's list of names

### Requirement: Wait tool
`wait` SHALL take `afterSeq`, an optional `timeoutMs` defaulting to sixty seconds and capped at ninety seconds so that the call stays a foreground tool call in Claude Code, and an optional `until` filter of `question`, `review`, `finished`, `stalled`, or `any`. It SHALL return the events since `afterSeq`, the latest sequence number, and the digest. When `until` is set it SHALL return early only when the digest satisfies the filter, otherwise at the timeout.

#### Scenario: Wait for a question
- **WHEN** `wait` is called with `until: question` and an agent blocks ten seconds later
- **THEN** the call returns within eleven seconds with the question in `openQuestions`

#### Scenario: Cap enforced
- **WHEN** `wait` is called with `timeoutMs` of ten minutes
- **THEN** it returns within ninety seconds

### Requirement: Start tool
`start` SHALL perform the daemon lifecycle `start` for the resolved run, creating the run directory if needed, and SHALL return the URL, pid, run directory, and graph path. It SHALL be safe to call repeatedly.

#### Scenario: Fresh repository
- **WHEN** `start` is called in a repository with no run directory
- **THEN** the run directory is created, a daemon is spawned, and the URL answers `status` within the bounded time

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
