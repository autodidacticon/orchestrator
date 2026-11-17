## ADDED Requirements

### Requirement: Configuration route: limit keys
`PUT /v1/config` SHALL take `budgets: { maxLaunchMs }` and `health: { stuckAfterMs, stuckFailAfterMs }`, each leaf a value or null and each block a value or null, applying toolchain-discovery "Runtime limit overrides". A refusal SHALL be a 400 whose `key` is the dotted key (`budgets.maxLaunchMs`, `health.stuckAfterMs`, `health.stuckFailAfterMs`, or the unknown leaf). `applied` SHALL name the block, `budgets` or `health`. `start` SHALL pass the blocks to a daemon it spawns as `--set budgets=<json>` and `--set health=<json>`, and through the route to one already running. A refusal by a daemon that `start` spawns SHALL be readable from the error `start` returns: the daemon SHALL write its usage text before the refusal line, so the tail of its log ends with the refusal.

#### Scenario: The spawn path takes the limit blocks
- **WHEN** `start` on a stopped run passes `budgets: { maxLaunchMs: 10800000 }` and `health: { stuckAfterMs: 0 }`
- **THEN** the spawned daemon's `GET /v1/config` gives both leaves with source `argument`

#### Scenario: A refusal at spawn is readable
- **WHEN** `start` on a stopped run with the default limits passes `health: { stuckFailAfterMs: 600000 }`
- **THEN** the call fails, and its error text ends with the refusal line, which holds 600000 and 900000

### Requirement: Configuration command: set flags
`orchestrator-ctl config` SHALL take `--set key=value` (repeatable) for every key `start --set` takes, including `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs`, parse it as `start` does, and merge it per leaf into the one `PUT /v1/config` built from the other flags. A call SHALL name each leaf once: the same leaf (a key, or `block.leaf`), or a block and a leaf under it, named by two of `--set`, `--clear`, `--allow` (the key `allowedTools`) and the per-key flags SHALL be refused before anything is sent. A repeated `--set allowedTools` appends rules and names the key once. Different leaves of one block SHALL merge. A `--set` with an unknown key or a bad value SHALL be refused before anything is sent, naming the key. The CLI usage SHALL name `--set` on `config` and the three limit keys.

#### Scenario: A limit set and cleared from the CLI
- **WHEN** `orchestrator-ctl config --set budgets.maxLaunchMs=10800000` runs, then `orchestrator-ctl config --clear budgets.maxLaunchMs`
- **THEN** the override document is `{ budgets: { maxLaunchMs: 10800000 } }` after the first and empty after the second

#### Scenario: A leaf named twice
- **WHEN** `config --set capacity=3 --capacity 4`, or `config --clear budgets.maxLaunchMs --set budgets.maxLaunchMs=1`, runs
- **THEN** it fails before any request and the override document is unchanged

#### Scenario: Leaves of one block merge
- **WHEN** `config --set codex.model=gpt-6-pro --sandbox read-only` runs
- **THEN** the override document holds both leaves under `codex`

### Requirement: Status report: limits in force
`status.budgets` SHALL keep its shape (`maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, `stuckFailAfterMs`) and SHALL give the values of `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs` in force, overrides applied. `maxRunCostUsd` SHALL stay the start-time value.

#### Scenario: Status after an override of 0
- **WHEN** `health: { stuckFailAfterMs: 0 }` is applied
- **THEN** `status.budgets.stuckFailAfterMs` is 0 at once

#### Scenario: Status after a clear
- **WHEN** the override is cleared with a null leaf
- **THEN** `status.budgets.stuckFailAfterMs` is the file value, else the default
