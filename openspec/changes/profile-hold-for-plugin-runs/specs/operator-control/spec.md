## ADDED Requirements

### Requirement: Profile hold default for a spawned daemon

The daemon SHALL take `--default-confirm-profile on|off`. Any other value SHALL end the start with an error that holds `--default-confirm-profile must be on or off, not <value>`, whatever the file says and before the store is opened. After the store is open, at every start: when `orchestrator.yaml` states `runner.confirmProfile` as a boolean, the daemon SHALL write the stored choice (kv `runner.confirmProfile`) as `on` or `off` to match the file; else, when the flag is given and the store holds no choice, it SHALL write the flag's value; else it SHALL write nothing. So the file's value SHALL overwrite the stored choice at every start, and a file line that is later removed SHALL leave the last stored choice in force. The stored choice SHALL belong to the run: a start without the flag (by `orchestrator-ctl`, by hand or by a revival) SHALL keep it. `orchestrator-ctl`, a daemon started by hand and a cluster daemon SHALL never pass the flag by themselves.

`startDaemon` SHALL take `defaultConfirmProfile?: boolean` and pass the flag only to a daemon it spawns, independent of `--mode` and `--default-mode`. A running daemon SHALL keep the choice it has. The start result SHALL carry `confirmProfile`, the hold in force read from the status probe's `runner.confirmProfile`, in every path, also when the daemon is already running and a `mode` is passed (where the result's `mode` stays the passed `mode`). The field SHALL be absent only when the probe fails.

A run that existed before this requirement has no stored choice. It SHALL adopt the hold the next time a daemon is spawned for it with the flag `on`, by a start or by a revival, and its `unstarted` tasks are then held.

#### Scenario: The default is adopted once and kept

- **WHEN** `startDaemon({ defaultConfirmProfile: true })` starts a fresh run whose file states no `runner.confirmProfile`
- **THEN** the result has `confirmProfile: true`
- **AND** while that daemon runs, `startDaemon({ mode: "pull" })` returns `started: false`, `mode: "pull"` and `confirmProfile: true`
- **AND** after a stop, `startDaemon()` without the option returns `confirmProfile: true`

#### Scenario: A stored off is not turned on by the default

- **WHEN** a run was first started with `defaultConfirmProfile: false` and is started again with `true`
- **THEN** the result has `confirmProfile: false`

#### Scenario: The file overwrites the stored choice

- **WHEN** a run whose stored choice is `on` is started after `runner: { confirmProfile: false }` is added to `orchestrator.yaml`
- **THEN** the result has `confirmProfile: false`, with or without `defaultConfirmProfile: true`
- **AND** after the line is removed again, a start with `defaultConfirmProfile: true` still returns `confirmProfile: false`

#### Scenario: A bad flag value

- **WHEN** the daemon is started with `--default-confirm-profile maybe`
- **THEN** the start fails with `--default-confirm-profile must be on or off, not maybe` before the store is opened
