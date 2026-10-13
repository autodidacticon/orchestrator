## MODIFIED Requirements

### Requirement: Operator interface
The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them. The operations SHALL be `status`, `answer`, `cancel` with optional release, `reopen` with optional cascade, `unblock`, `accept`, `reject`, `pause`, `resume` with optional budget override, `logs`, `events`, `review`, `import`, `shutdown`, `start` with optional mode and configuration arguments, `stop`, `runs`, `outbox`, `ack`, `nudge`, `proposals`, `accept_proposal`, `reject_proposal`, `claim`, `release`, `mode`, and `config` to show and set the configuration. Humans and host sessions SHALL act only through this interface.

#### Scenario: CLI reaches the daemon
- **WHEN** `status` is run while the daemon is up
- **THEN** it prints the current report from the daemon

#### Scenario: MCP and CLI share one implementation
- **WHEN** the same operation is invoked through the CLI and through the MCP server
- **THEN** both produce the same event and the same effect

## ADDED Requirements

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`; and `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification. It SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`. The CLI SHALL expose `orchestrator-ctl config`, printing the block without flags and setting keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, and `--clear <key>` (repeatable).

#### Scenario: Set the check command
- **WHEN** `PUT /v1/config` carries `{ checkCommand: "npm test" }` while it was unresolved
- **THEN** the response lists `checkCommand` under `applied` with source `argument`, the event log holds `operator.config` with the patch, and `needsConfig` is empty

#### Scenario: Show the configuration
- **WHEN** `orchestrator-ctl config` is run without flags
- **THEN** it prints every key with its value and source, the toolchain record, and `needsConfig`

#### Scenario: Add a tool rule from the CLI
- **WHEN** `orchestrator-ctl config --allow "Bash(docker:*)"` is run
- **THEN** the allow list's `argument` part contains the rule and the next spawned launch is given it

#### Scenario: Mixed request applies nothing
- **WHEN** `PUT /v1/config` carries a valid `capacity` and an invalid `checkCommand` of empty string
- **THEN** the response is 400 naming `checkCommand` and the capacity is unchanged

### Requirement: Status report: configuration
`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf and `allowedTools` carrying `parts` and `applied`; `toolchain`, the detection record; and `needsConfig`, the keys whose value is unresolved. The event stream digest SHALL carry `needsConfig`. Both SHALL be present when no graph is loaded.

#### Scenario: Detected values visible
- **WHEN** `status` is requested in a Node repository started without a file
- **THEN** `config.checkCommand` is `{ value: "npm test", source: "detected" }`, `config.integrationBranch` names the detected branch with its source, and `toolchain.kinds` contains `node`

#### Scenario: Unresolved check command visible
- **WHEN** the repository has no recognised manifest and no file
- **THEN** `status.needsConfig` and the digest's `needsConfig` both equal `["checkCommand"]`

#### Scenario: Reported before a graph is loaded
- **WHEN** `status` is requested before any graph has been imported
- **THEN** the response carries `config`, `toolchain`, and `needsConfig` alongside `error: graph not loaded`

### Requirement: Start arguments
The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, and `runnerCommand` beside `mode`. When it spawns the daemon it SHALL pass each as a `--set key=value` flag, which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason. The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy. `orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving.

#### Scenario: Start with a check command
- **WHEN** `start` is called with `checkCommand: "npm test"` in a repository with no file and no daemon
- **THEN** the daemon is spawned with `--set checkCommand=npm test`, and the result's `config.checkCommand` is `{ value: "npm test", source: "argument" }`

#### Scenario: Start applies to a running daemon
- **WHEN** `start` is called with `capacity: 3` while the daemon runs
- **THEN** no second daemon is spawned, `status.config.capacity` is `{ value: 3, source: "argument" }`, and the result reports `started: false`

#### Scenario: Start-only key on a running daemon
- **WHEN** `start` is called with `integrationBranch: develop` while the daemon runs on `main`
- **THEN** the result reports `integrationBranch` under `rejected` as start-only and the daemon keeps `main`

#### Scenario: Result says what was detected
- **WHEN** `start` spawns the daemon in a repository with `Cargo.toml`
- **THEN** the result's `toolchain.kinds` contains `rust` and `config.checkCommand.value` is `cargo test`
