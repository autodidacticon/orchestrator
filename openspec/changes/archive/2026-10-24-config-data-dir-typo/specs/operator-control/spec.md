## MODIFIED Requirements

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`; and `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, `codex`, and `opencode` (the per-kind leaves; `opencode` holds `model`, `effort`, `commit`, `command`, `permission`, and `dataDir`), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification. It SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`. The CLI SHALL expose `orchestrator-ctl config`. Without flags it SHALL print the block, including `runnerKind` and the `claude`, `codex`, and `opencode` leaves with their sources. It SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--permission <derived|allow>` (the key `opencode.permission`), `--data-dir <shared|launch>` (the key `opencode.dataDir`; on `config` a value of `shared` or `launch` SHALL be read as the leaf, and any other value SHALL keep naming the store location when no daemon URL is given; when `--url` or `ORCH_URL` addresses the daemon, any other value SHALL be refused before anything is sent, with a message naming both meanings and the two accepted values), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` or `opencode.permission` clears one leaf). `--runner-kind` SHALL take `claude-code`, `codex`, or `opencode`. `--commit` SHALL set the commit policy of `--runner-kind` when it is given in the same call, else of the kind in force. A call that clears a key and sets a leaf under it (`--clear codex --sandbox read-only`, `--clear codex.sandbox --sandbox read-only`) SHALL be refused before anything is sent, naming both, and so SHALL `--clear runnerKind` together with `--commit` unless `--runner-kind` names the kind the policy binds to; the daemon refuses the same patch shapes. The operator-surface fold (`foldRunnerArgs`) SHALL put `permission` and `dataDir` arguments under `opencode` and SHALL refuse them beside a cleared `opencode` or a cleared leaf of the same name, with the same message. The CLI usage SHALL name the three kinds and their default models and efforts (`claude-opus-5-5`, `gpt-6-astra`, and `anthropic/claude-opus-5-5`, all at `medium`) and SHALL say that `ultra` is codex-only. The MCP `configure` tool SHALL take `opencode: { model, effort }`, `permission`, and `dataDir` beside the codex arguments, folded the same way, and SHALL forward the route's refusal of an effort the kind lacks (`ultra` for opencode), whose message names the kind.

#### Scenario: Select OpenCode from the CLI
- **WHEN** `orchestrator-ctl config --runner-kind opencode --permission allow --data-dir launch` is run, then `orchestrator-ctl config --clear opencode.permission`, then `orchestrator-ctl config --commit daemon --runner-kind opencode`
- **THEN** the bodies sent are `{ runnerKind: "opencode", opencode: { permission: "allow", dataDir: "launch" } }`, `{ opencode: { permission: null } }`, and `{ runnerKind: "opencode", opencode: { commit: "daemon" } }`

#### Scenario: Mistyped data-dir leaf with a daemon URL
- **WHEN** `orchestrator-ctl --url X config --data-dir lanch` is run, or `orchestrator-ctl config --data-dir lanch` with `ORCH_URL` set
- **THEN** the CLI exits non-zero with a message naming `opencode.dataDir`, the values `shared` and `launch`, and the store location, and no request is sent

#### Scenario: Data-dir names the store without a daemon URL
- **WHEN** `orchestrator-ctl config --data-dir <path>` is run with neither `--url` nor `ORCH_URL`
- **THEN** the daemon URL is read from the store under `<path>` and the configuration block is printed

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
