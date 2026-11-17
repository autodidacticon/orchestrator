## ADDED Requirements

### Requirement: Codex network access override

The override document SHALL hold the leaf `codex.networkAccess`, which takes `true`, `false` or null. `true` and `false` SHALL be stored as overrides, and `false` SHALL win over a file that sets `runner.codex.networkAccess: true`. Only null SHALL clear the override, so the value falls back to the file, else to unset. Any other value, the strings `"true"` and `"false"` included, SHALL be refused with 400 naming `codex.networkAccess`, and nothing of the patch SHALL be stored. The leaf SHALL be settable through `PUT /v1/config` (`{ codex: { networkAccess } }`), the `start` and `configure` tools (a flat argument `networkAccess`, folded under `codex`), `--set codex.networkAccess=<value>` (exactly `true` or `false`; any other text is a usage error naming the key) and the JSON-object form `--set codex={"networkAccess":...}`, and `orchestrator-ctl config --set` and `--clear codex.networkAccess`. The configuration report in `status`, `GET /v1/config`, the start result and `config.json` SHALL show `config.codex.networkAccess` as `{ value, source }` with source `argument`, `file` or `default`, and the effective `runner.codex.networkAccess` SHALL be the resolved value. The value SHALL apply to launches spawned or claimed after the change; a running launch SHALL keep its command line. The key SHALL be accepted and reported under every sandbox, with a `codex.command` that has no `{codexOverrides}` slot, and under a run kind that is not `codex`, with no refusal and no warning. Unlike the runner, model and effort fixed on the launch row at preparation, the Codex settings, `codex.sandbox` included, SHALL be read when a launch's command is composed: by the spawning runner at spawn and by the claim when a launch is claimed. A launch parked before the change and claimed after it SHALL run with the new value and the brief of its last preparation.

#### Scenario: Set to true
- **WHEN** `PUT /v1/config { codex: { networkAccess: true } }` is sent before the first launch of a codex run
- **THEN** the answer is 200 with `applied: ['codex']` and `config.codex.networkAccess` is `{ value: true, source: 'argument' }`
- **AND** the command line of the next spawned launch holds `-c sandbox_workspace_write.network_access=true`

#### Scenario: File true, override false
- **WHEN** `orchestrator.yaml` sets `runner.codex.networkAccess: true` and the override `{ codex: { networkAccess: false } }` is stored
- **THEN** `config.codex.networkAccess` is `{ value: false, source: 'argument' }`
- **AND** the command line of a launch spawned afterwards holds no `sandbox_workspace_write.network_access` override

#### Scenario: Clear
- **WHEN** the stored document is `{ codex: { sandbox: 'read-only', networkAccess: true } }` and `{ codex: { networkAccess: null } }` is applied
- **THEN** the stored document is `{ codex: { sandbox: 'read-only' } }`
- **AND** the leaf falls back to the file, else to `{ value: undefined, source: 'default' }`

#### Scenario: A non-boolean is refused
- **WHEN** `PUT /v1/config { codex: { networkAccess: 'true' } }` is sent, or `orchestrator-ctl config --set codex.networkAccess=maybe` is run
- **THEN** the route answers 400 with `key: 'codex.networkAccess'`, or the CLI exits with a usage error that names `codex.networkAccess`
- **AND** the stored document is unchanged

#### Scenario: A running launch keeps its command line
- **WHEN** a Codex launch is running and `codex.networkAccess` is changed
- **THEN** the running process keeps the command line it was spawned with
- **AND** only launches spawned or claimed after the change see the new value

#### Scenario: A launch parked before the change and claimed after it
- **WHEN** a Codex launch is claimable in pull mode, `codex.networkAccess` is set to `true`, and the launch is then claimed
- **THEN** the claim's `codex.settings.networkAccess` is `true`
- **AND** the launch keeps the brief of its last preparation
