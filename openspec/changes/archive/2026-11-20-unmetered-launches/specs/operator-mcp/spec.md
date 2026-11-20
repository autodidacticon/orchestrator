## ADDED Requirements

### Requirement: Wait digest: unmeteredLaunches
The wait digest SHALL carry `unmeteredLaunches`, a number equal to `status.cost.unmeteredLaunches`. It SHALL be 0 when no graph is loaded.

#### Scenario: Equal to the status count
- **WHEN** two launches are unmetered
- **THEN** the digest's `unmeteredLaunches` is 2, as is `status.cost.unmeteredLaunches`

#### Scenario: Without a graph
- **WHEN** no graph is loaded
- **THEN** the digest's `unmeteredLaunches` is 0
