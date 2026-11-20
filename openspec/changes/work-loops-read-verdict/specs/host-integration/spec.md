## MODIFIED Requirements

### Requirement: Work loop by runner kind: stop rule
A loop SHALL read `workByKind.<kind>.verdict` from `GET /v1/status` for its one kind and react: `finished` and `stalled` stop; `human` stops with "nothing is claimable for <kind> and the run waits on a human"; `idle` stops once the quiet has lasted `--idle-exit-ms`; `claim`, `standby`, `paused` and a word the loop does not know keep it polling with the idle timer reset. The verdict wins over the status's other fields.

#### Scenario: Quiet with an open question
- **WHEN** status shows the run neither finished nor stalled, nothing claimable, prepared, live or verifying for `codex`, and an open question, so `workByKind.codex.verdict` is `human`
- **THEN** `stopVerdict` stops with "nothing is claimable for codex and the run waits on a human"; without the question the verdict is `idle` and it stops once the quiet has lasted `--idle-exit-ms`

#### Scenario: Standby wins over the other fields
- **WHEN** `workByKind.codex.verdict` is `standby` while the status shows an open question, nothing claimable and no live launch
- **THEN** `stopVerdict` answers `{ stop: false, quiet: false }`

## ADDED Requirements

### Requirement: Work loop by runner kind: stop rule without a verdict
A status without `workByKind.<kind>.verdict` (an older daemon) SHALL go through the earlier rule: stop when the run is finished or stalled; or when nothing is claimable, prepared (a missing `preparingByKind` counts 0) or live for the kind, nothing is verifying, the run is not paused, and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`.

#### Scenario: Older daemon
- **WHEN** a status without `workByKind` shows nothing claimable, prepared, live or verifying for `codex` and an open question
- **THEN** `stopVerdict` stops with "nothing is claimable for codex and the run waits on a human"
