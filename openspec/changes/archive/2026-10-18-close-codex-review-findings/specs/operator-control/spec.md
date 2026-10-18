## MODIFIED Requirements

### Requirement: Configuration route
The daemon SHALL expose `GET /v1/config`, returning the resolved configuration with value and source per key, the `toolchain` detection record, the overrides in force, and `needsConfig`; and `PUT /v1/config`, taking any of `checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, `claude`, and `codex` (the per-kind leaves), each a value or null to clear, applying the runtime override rules of the toolchain-discovery specification. It SHALL validate the whole body before applying anything, answer 400 naming an invalid key and 409 naming a start-only key, and otherwise record an `operator.config` event carrying the patch and the override document in one transaction, rewrite `config.json`, append `config.resolved`, wake the loop, and return the new `config` block with the keys it `applied`. The CLI SHALL expose `orchestrator-ctl config`. Without flags it SHALL print the block, including `runnerKind` and the `claude` and `codex` leaves with their sources. It SHALL set keys with `--check-command`, `--capacity`, `--allow <rule>` (repeatable), `--runner-command`, `--runner-kind <kind>`, `--model`, `--effort`, `--sandbox <mode>` (the key `codex.sandbox`), `--commit <agent|daemon>`, and `--clear <key>` (repeatable; a per-kind key such as `codex.sandbox` clears one leaf). `--commit` SHALL set the commit policy of `--runner-kind` when it is given in the same call, else of the kind in force. A call that clears a key and sets a leaf under it (`--clear codex --sandbox read-only`, `--clear codex.sandbox --sandbox read-only`) SHALL be refused before anything is sent, naming both, and so SHALL `--clear runnerKind` together with `--commit` unless `--runner-kind` names the kind the policy binds to; the daemon refuses the same patch shapes. The CLI usage SHALL name both kinds' default models and efforts (`claude-opus-5-5` and `gpt-6-astra`, both at `medium`) and SHALL say that `ultra` is codex-only.

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
