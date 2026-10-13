## MODIFIED Requirements

### Requirement: Start tool
`start` SHALL perform the daemon lifecycle `start` for the resolved run, creating the run directory if needed, and SHALL return the URL, pid, run directory, and graph path. It SHALL be safe to call repeatedly. It SHALL accept the optional configuration arguments `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, and `runnerCommand` beside `mode`, pass them to the lifecycle `start`, and return the `config` block with value and source per key, the `toolchain` record, `needsConfig`, and any `rejected` keys, so that the session can report what was detected and set what was not.

#### Scenario: Fresh repository
- **WHEN** `start` is called in a repository with no run directory
- **THEN** the run directory is created, a daemon is spawned, and the URL answers `status` within the bounded time

#### Scenario: Detection reported
- **WHEN** `start` is called in a Node repository with no file
- **THEN** the result's `config.checkCommand` is `{ value: "npm test", source: "detected" }` and `needsConfig` is empty

#### Scenario: Check command given at start
- **WHEN** `start` is called with `checkCommand: "make check"` on a running daemon
- **THEN** the tool applies it through the configuration route and the result's `config.checkCommand` has source `argument`

## ADDED Requirements

### Requirement: Configure tool
The server SHALL expose `configure`, taking any of `checkCommand`, `capacity`, `allowedTools`, and `runnerCommand`, each a value or null to clear, and forwarding to `PUT /v1/config`; it SHALL return the route's response as a single JSON text block, including a 400 or 409 unchanged. The `status` tool description SHALL mention the `config`, `toolchain`, and `needsConfig` facts, and the `wait` tool description SHALL mention `needsConfig` in the digest.

#### Scenario: Tool list includes configure
- **WHEN** a client lists tools
- **THEN** `configure` is present with an input schema whose properties are `checkCommand`, `capacity`, `allowedTools`, and `runnerCommand`, all optional

#### Scenario: Set the check command through the tool
- **WHEN** `configure` is called with `checkCommand: "npm test"` while it was unresolved
- **THEN** the daemon records the operator event, the result lists `checkCommand` under `applied`, and the next `wait` digest has an empty `needsConfig`

#### Scenario: Refusal passes through
- **WHEN** `configure` is called with `capacity: 0`
- **THEN** the result carries status 400 naming `capacity` and `isError` is true
