## MODIFIED Requirements

### Requirement: Remote verification and restarts: stop
`stop()` SHALL end a run that waits for a result at once and record nothing; the job row SHALL stay as it is for the next start. A run already past its wait SHALL finish as before.

#### Scenario: Stop while waiting
- **WHEN** `stop()` is called while a job waits for a result
- **THEN** it returns within one second of the moment the reap and the prepare-command stop end, and the job row is unchanged
