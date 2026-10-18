## MODIFIED Requirements

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
