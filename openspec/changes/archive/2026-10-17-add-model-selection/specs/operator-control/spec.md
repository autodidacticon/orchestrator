## MODIFIED Requirements

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`; and `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `model`, `effort`, each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification. It SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`. The CLI SHALL expose `orchestrator-ctl config`, printing the block without flags and setting keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--model`, `--effort`, and `--clear <key>` (repeatable).

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

#### Scenario: Set the effort from the CLI
- **WHEN** `orchestrator-ctl config --effort high` is run
- **THEN** `config.effort` is `{ value: "high", source: "argument" }` and the next prepared launch has `effort: high`

### Requirement: Status report: configuration
`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf, `allowedTools` carrying `parts` and `applied`, and `model` and `effort` each carrying `applied`; `toolchain`, the detection record; and `needsConfig`, the keys whose value is unresolved. Each entry of `liveLaunches` SHALL carry the launch's `model` and `effort`. The event stream digest SHALL carry `needsConfig`. The configuration facts SHALL be present when no graph is loaded.

#### Scenario: Detected values visible
- **WHEN** `status` is requested in a Node repository started without a file
- **THEN** `config.checkCommand` is `{ value: "npm test", source: "detected" }`, `config.integrationBranch` names the detected branch with its source, `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`, and `toolchain.kinds` contains `node`

#### Scenario: Unresolved check command visible
- **WHEN** the repository has no recognised manifest and no file
- **THEN** `status.needsConfig` and the digest's `needsConfig` both equal `["checkCommand"]`

#### Scenario: Reported before a graph is loaded
- **WHEN** `status` is requested before any graph has been imported
- **THEN** the response carries `config`, `toolchain`, and `needsConfig` alongside `error: graph not loaded`

#### Scenario: Live launch selection visible
- **WHEN** T2 is live from a task that declares `effort: high`
- **THEN** `status.liveLaunches` has T2 with `effort: "high"` and `model: "claude-opus-5-5"`

### Requirement: Start arguments
The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `model`, and `effort` beside `mode`. When it spawns the daemon it SHALL pass each as a `--set key=value` flag, which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason. The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy. `orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving.

#### Scenario: Model set at start
- **WHEN** `start` is called with `model: "claude-sonnet-5-5"` in a repository with no running daemon
- **THEN** the daemon is spawned with `--set model=claude-sonnet-5-5` and the result's `config.model` is `{ value: "claude-sonnet-5-5", source: "argument", applied: true }`

#### Scenario: Invalid effort refused before serving
- **WHEN** the daemon is started with `--set effort=huge`
- **THEN** it exits with a usage error naming `effort` and never serves
