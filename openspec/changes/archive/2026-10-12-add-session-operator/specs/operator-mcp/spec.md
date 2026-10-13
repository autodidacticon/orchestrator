## ADDED Requirements

### Requirement: Operator MCP server
The package SHALL provide `orchestrator-mcp`, a stdio MCP server that exposes operator operations as tools and forwards each to the daemon's HTTP routes. It SHALL never open the store directly. It SHALL resolve the run directory from a `--repo` argument, the `ORCH_REPO` environment variable, or the git top level of its working directory, in that order.

#### Scenario: Tools forward to routes
- **WHEN** the `answer` tool is called for task T1 with text
- **THEN** the daemon records an operator answer event for T1 and the tool returns the route's response

#### Scenario: Daemon not running
- **WHEN** a tool other than `start`, `runs`, or `status` is called and no daemon answers
- **THEN** the tool returns an error naming the run directory and suggesting `start`

### Requirement: Tool set
The server SHALL expose `start`, `stop`, `status`, `runs`, `import_issues`, `import_graph`, `wait`, `review`, `answer`, `cancel`, `reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, and `logs`. Mutating tools SHALL require the same arguments as the corresponding CLI commands. Every tool result SHALL be a single JSON text block.

#### Scenario: Tool list
- **WHEN** a client lists tools
- **THEN** exactly these seventeen tools are present with input schemas

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
