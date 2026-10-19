## MODIFIED Requirements

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`; and `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` (the per-kind leaves; `opencode` holds `model`, `effort`, `commit`, `command`, `permission`, and `dataDir`), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification. It SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`. The CLI SHALL expose `orchestrator-ctl config`. Without flags it SHALL print the block, including `runnerKind` and the `claude`, `codex`, and `opencode` leaves with their sources. It SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--permission <derived|allow>` (the key `opencode.permission`), `--data-dir <shared|launch>` (the key `opencode.dataDir`; on `config` a value of `shared` or `launch` SHALL be read as the leaf, and any other value SHALL keep naming the store location), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` or `opencode.permission` clears one leaf). `--runner-kind` SHALL take `claude-code`, `codex`, or `opencode`. `--commit` SHALL set the commit policy of `--runner-kind` when it is given in the same call, else of the kind in force. A call that clears a key and sets a leaf under it (`--clear codex --sandbox read-only`, `--clear codex.sandbox --sandbox read-only`) SHALL be refused before anything is sent, naming both, and so SHALL `--clear runnerKind` together with `--commit` unless `--runner-kind` names the kind the policy binds to; the daemon refuses the same patch shapes. The operator-surface fold (`foldRunnerArgs`) SHALL put `permission` and `dataDir` arguments under `opencode` and SHALL refuse them beside a cleared `opencode` or a cleared leaf of the same name, with the same message. The CLI usage SHALL name the three kinds and their default models and efforts (`claude-opus-5-5`, `gpt-6-astra`, and `anthropic/claude-opus-5-5`, all at `medium`) and SHALL say that `ultra` is codex-only. The MCP `configure` tool SHALL take `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, folded the same way, and SHALL forward the route's refusal of an effort the kind lacks (`ultra` for opencode), whose message names the kind.

#### Scenario: Select OpenCode from the CLI
- **WHEN** `orchestrator-ctl config --runner-kind opencode --permission allow --data-dir launch` is run, then `orchestrator-ctl config --clear opencode.permission`, then `orchestrator-ctl config --commit daemon --runner-kind opencode`
- **THEN** the bodies sent are `{ runnerKind: "opencode", opencode: { permission: "allow", dataDir: "launch" } }`, `{ opencode: { permission: null } }`, and `{ runnerKind: "opencode", opencode: { commit: "daemon" } }`

#### Scenario: OpenCode leaves on the configure tool
- **WHEN** the `configure` tool is called with `opencode: { model: "opencode/big-pickle" }`, and then with `runnerKind: "opencode"` and `effort: "ultra"`
- **THEN** the first sets `opencode.model` with source `argument`, and the second is refused with 400 naming `effort` and `opencode`

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

#### Scenario: Select Codex from the CLI
- **WHEN** `orchestrator-ctl config --runner-kind codex --sandbox danger-full-access` is run and then `orchestrator-ctl config` is run without flags
- **THEN** it prints `runnerKind` as `{ value: "codex", source: "argument" }`, `codex.sandbox` as `{ value: "danger-full-access", source: "argument" }`, and `codex.commit` as `{ value: "agent", source: "default" }`

#### Scenario: Commit policy binds to the kind in force
- **WHEN** the kind in force is `codex` and `orchestrator-ctl config --commit daemon` is run
- **THEN** `codex.commit` is `{ value: "daemon", source: "argument" }` and `claude.commit` is unchanged

#### Scenario: Clear and set in one call refused
- **WHEN** `orchestrator-ctl config --clear codex --sandbox read-only` is run
- **THEN** the CLI exits non-zero naming `codex` and `codex.sandbox`, and no `PUT /v1/config` is made

#### Scenario: OpenCode leaves fold under their namespace
- **WHEN** `--set opencode.model=opencode/big-pickle --set opencode.dataDir=launch` is given, and the fold receives `{ commit: "daemon", runnerKind: "opencode" }`, and separately `{ opencode: null, dataDir: "launch" }`
- **THEN** the first is `{ opencode: { model: "opencode/big-pickle", dataDir: "launch" } }`, the second `{ runnerKind: "opencode", opencode: { commit: "daemon" } }`, and the third is refused naming `opencode` and `opencode.dataDir`

### Requirement: Status report: configuration
`status` SHALL additionally report `config`, every configuration key as `{ value, source }` with nested blocks per leaf, `runnerKind` (the kind in force), `allowedTools` carrying `parts` and `applied`, `model` and `effort` (those of the kind in force) each carrying `applied`, and the `claude`, `codex`, and `opencode` leaves (among them `codex.sandbox`, `opencode.permission`, `opencode.dataDir`, and each kind's `commit`); `toolchain`, the detection record; and `needsConfig`, the keys whose value is unresolved. Each entry of `liveLaunches` SHALL carry the launch's `runner`, `model`, and `effort`. The event stream digest SHALL carry `needsConfig`. The configuration facts SHALL be present when no graph is loaded.

#### Scenario: Detected values visible
- **WHEN** `status` is requested in a Node repository started without a file
- **THEN** `config.checkCommand` is `{ value: "npm test", source: "detected" }`, `config.integrationBranch` names the detected branch with its source, `config.runnerKind` is `{ value: "claude-code", source: "default" }`, `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`, and `toolchain.kinds` contains `node`

#### Scenario: Unresolved check command visible
- **WHEN** the repository has no recognised manifest and no file
- **THEN** `status.needsConfig` and the digest's `needsConfig` both equal `["checkCommand"]`

#### Scenario: Reported before a graph is loaded
- **WHEN** `status` is requested before any graph has been imported
- **THEN** the response carries `config`, `toolchain`, and `needsConfig` alongside `error: graph not loaded`

#### Scenario: Live launch selection visible
- **WHEN** T2 is live from a task that declares `effort: high`
- **THEN** `status.liveLaunches` has T2 with `runner: "claude-code"`, `effort: "high"`, and `model: "claude-opus-5-5"`

#### Scenario: Codex leaves visible
- **WHEN** `status` is requested on a run whose file sets `runner.kind: codex`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "file" }`, `config.model` is `gpt-6-astra`, and `config.codex.sandbox` and `config.codex.commit` carry their values and sources

#### Scenario: OpenCode leaves visible
- **WHEN** `status` is requested on a run started with `--set runnerKind=opencode`
- **THEN** `config.runnerKind` is `{ value: "opencode", source: "argument" }` and `config.opencode.model` is `{ value: "anthropic/claude-opus-5-5", source: "default" }`, with `opencode.effort`, `opencode.commit`, `opencode.permission`, and `opencode.dataDir` carrying their values and sources

### Requirement: Start arguments
The daemon lifecycle `start` SHALL accept `checkCommand`, `integrationBranch`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` beside `mode`. When it spawns the daemon it SHALL pass each as a `--set key=value` flag (a per-kind block as a JSON object), which the daemon stores as an override before resolving; when the daemon is already healthy it SHALL apply them through `PUT /v1/config` and SHALL report any key the route refused under `rejected` with the route's reason. The result SHALL carry `config`, `toolchain`, and `needsConfig` as read from `GET /v1/config` after the daemon is healthy. `orchestrator-ctl start` SHALL accept the same keys as repeatable `--set key=value` flags, the per-kind leaves as dotted keys (`claude.model`, `claude.effort`, `claude.commit`, `codex.model`, `codex.effort`, `codex.sandbox`, `codex.commit`, `codex.command`, `opencode.model`, `opencode.effort`, `opencode.commit`, `opencode.command`, `opencode.permission`, `opencode.dataDir`), and the daemon's `--set` SHALL reject an unknown key or an invalid value with a usage error before serving. The daemon's usage SHALL list these keys. The MCP `start` tool SHALL take `runnerKind` (`claude-code`, `codex`, or `opencode`), `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, and its argument text SHALL name the opencode defaults (`anthropic/claude-opus-5-5` at `medium`, commit `agent`, permission `derived`, dataDir `shared`). Without `mode`, and with no mode configured or chosen by the run, it SHALL start a run whose kind in force is `codex` or `opencode` in `spawn`, with a `modeNote` naming the kind and saying that pull-mode workers for it come from `orchestrator-work --runner <kind>`; a `codex` or `opencode` run in `pull` SHALL get a `modeNote` that names the kind.

#### Scenario: OpenCode run defaults to spawn
- **WHEN** the `start` tool is called with `runnerKind: "opencode"` on a run with no configured mode
- **THEN** the result has `mode: "spawn"` and a `modeNote` naming `orchestrator-work --runner opencode`

#### Scenario: Model set at start
- **WHEN** `start` is called with `model: "claude-sonnet-5-5"` in a repository with no running daemon
- **THEN** the daemon is spawned with `--set model=claude-sonnet-5-5` and the result's `config.model` is `{ value: "claude-sonnet-5-5", source: "argument", applied: true }`

#### Scenario: Invalid effort refused before serving
- **WHEN** the daemon is started with `--set effort=huge`
- **THEN** it exits with a usage error naming `effort` and never serves

#### Scenario: Codex selected at start
- **WHEN** `orchestrator-ctl start --set runnerKind=codex --set codex.sandbox=read-only` is run in a repository with no running daemon
- **THEN** the result's `config.runnerKind` is `{ value: "codex", source: "argument" }` and `config.codex.sandbox` is `{ value: "read-only", source: "argument" }`
