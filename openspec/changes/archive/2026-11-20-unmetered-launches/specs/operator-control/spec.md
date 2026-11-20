## ADDED Requirements

### Requirement: Status report: unmetered launches
`status.cost` SHALL carry `unmeteredLaunches`, the count of unmetered launches (health-monitoring "Usage accounting: unmetered launches"), derived from the launch rows so that a daemon started again on the same store reports the same count. The status body without a graph SHALL keep no `cost`.

#### Scenario: Counted from the rows
- **WHEN** two spawned launches have ended with no usage and a new orchestrator is started on the same store
- **THEN** both report `status.cost.unmeteredLaunches` 2
