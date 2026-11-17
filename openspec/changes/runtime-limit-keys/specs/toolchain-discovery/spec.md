## ADDED Requirements

### Requirement: Runtime limit overrides
The launch time budget and the two stuck limits SHALL be durable runtime overrides, nested as in the configuration file: `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs`. The override document SHALL hold them as `{ budgets: { maxLaunchMs }, health: { stuckAfterMs, stuckFailAfterMs } }`, and `budgets` and `health` in an override SHALL accept no other leaf: every other key of those blocks stays a start-time key of the file. A value SHALL be an integer from 0 to `Number.MAX_SAFE_INTEGER`; 0 SHALL disable the limit. A null leaf SHALL clear that override, and a null block SHALL clear every leaf of the block, so the value falls back to the file, else to the default. Any other value SHALL be refused naming the dotted key. `--set` SHALL read the three values as decimal digits only, and SHALL also take `budgets=` and `health=` as a JSON object.

Pair rule: a patch that touches `health.stuckAfterMs` or `health.stuckFailAfterMs` (a null leaf or a null `health` block counts) SHALL be refused when the pair in force after it would have both values above 0 and `health.stuckFailAfterMs` not above `health.stuckAfterMs`. Both keys MAY be set in one patch. The refusal SHALL name `health.stuckFailAfterMs` when the patch touches it, else `health.stuckAfterMs`, and its message SHALL give both keys, both values and the source of each. The rule SHALL NOT be evaluated for a patch that touches neither key, so a file whose own pair breaks it still starts and still takes a patch of another key. At start, when the pair in force breaks the rule, the daemon SHALL log one warning naming both values and their sources, and SHALL NOT refuse to start.

A change SHALL apply on the next tick to every live launch, to claims made afterwards, and to `status`, as health-monitoring "Limits read at every check" states; no change is refused for lowering a limit. A stored document with a key the reader does not know SHALL be read as empty, as before.

#### Scenario: A raise is stored and survives a restart
- **WHEN** a patch sets `budgets: { maxLaunchMs: 40000 }` and a new daemon opens the same store
- **THEN** the configuration report gives `budgets.maxLaunchMs` as `{ value: 40000, source: "argument" }` and the new daemon's first tick measures launches against 40000

#### Scenario: Zero disables, null falls back
- **WHEN** a patch sets `health: { stuckFailAfterMs: 0 }` and a later patch sets `health: { stuckFailAfterMs: null }`
- **THEN** after the first the leaf is `{ value: 0, source: "argument" }` and no launch is failed for silence; after the second it is the file value with source `file`, or the default with source `default`

#### Scenario: Bad values are refused
- **WHEN** a patch gives `budgets.maxLaunchMs` as -1, 1.5, the string "5000" or a value above `Number.MAX_SAFE_INTEGER`, or names `health.reportGraceMs`
- **THEN** it is refused with 400 naming the dotted key, and nothing is stored

#### Scenario: Digits only from --set
- **WHEN** `--set budgets.maxLaunchMs=` is given with an empty value, `abc`, `1.5`, `-1`, `1e3` or `0x10`
- **THEN** it is a usage error, and an empty value never disables the limit

#### Scenario: The pair rule refuses a fail limit at or below the flag limit
- **WHEN** the file gives 900000 and 2700000 and a patch sets `health: { stuckFailAfterMs: 600000 }`
- **THEN** it is refused naming `health.stuckFailAfterMs`, and the message holds 600000 and 900000 with their sources

#### Scenario: The pair rule accepts a pair set together, or a disabled flag limit
- **WHEN** a patch sets `health: { stuckAfterMs: 300000, stuckFailAfterMs: 600000 }`, or `health: { stuckAfterMs: 0, stuckFailAfterMs: 600000 }`
- **THEN** it is accepted

#### Scenario: The pair rule is skipped for other keys
- **WHEN** the file sets only `health.stuckFailAfterMs: 600000` (below the default flag limit) and a patch sets `capacity: 3`, or the daemon starts with no patch
- **THEN** the patch is accepted and the daemon starts, logging one warning that names both values and their sources

### Requirement: Limit leaves in the resolved configuration record
The configuration report (`GET /v1/config`, `status.config`, the start result and `config.json`) SHALL list `config.budgets.maxLaunchMs`, `config.health.stuckAfterMs` and `config.health.stuckFailAfterMs`, each as `{ value, source }` with source `argument`, `file` or `default`, and the `config.resolved` event SHALL carry the same `budgets` and `health` blocks. A source SHALL be read from the file's nested `budgets` and `health` blocks, and an override of 0 SHALL report source `argument`.

#### Scenario: Sources from the nested file blocks
- **WHEN** the file sets only `health.stuckFailAfterMs: 1800000`
- **THEN** the record gives `health.stuckFailAfterMs` `{ value: 1800000, source: "file" }`, `health.stuckAfterMs` `{ value: 900000, source: "default" }` and `budgets.maxLaunchMs` `{ value: 7200000, source: "default" }`

#### Scenario: The record follows an override
- **WHEN** `PUT /v1/config` sets `health: { stuckAfterMs: 0 }`
- **THEN** `config.json` and the `config.resolved` event appended for it give `health.stuckAfterMs` as `{ value: 0, source: "argument" }`
