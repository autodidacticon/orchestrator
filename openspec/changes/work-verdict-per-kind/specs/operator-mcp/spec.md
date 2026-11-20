## ADDED Requirements

### Requirement: Wait digest: workByKind
The digest of `GET /v1/events`, which the `wait` tool returns and the exit record holds, SHALL carry `workByKind` identical to the status's, every runner kind present.

#### Scenario: Same verdicts
- **WHEN** a `claude-code` task and a `codex` task are parked and `GET /v1/status`, `GET /v1/events` and the `wait` tool are read
- **THEN** all three carry the same `workByKind`

### Requirement: Status and wait descriptions: workByKind
The `status` and `wait` tool descriptions SHALL each name `workByKind` and say it gives, per runner kind, the verdict and its counts.

#### Scenario: Descriptions
- **WHEN** a client lists the tools
- **THEN** the `status` and the `wait` descriptions each contain `workByKind`
