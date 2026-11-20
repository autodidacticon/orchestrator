## ADDED Requirements

### Requirement: Usage accounting: launches reaped together
A reap of several launches SHALL send SIGTERM to every launch's process group before any wait, wait for all of them against one deadline of the runner's kill grace, send SIGKILL to every group still present, and wait at most 1000 ms more. Usage SHALL be read after that wait. Each pid SHALL otherwise be handled as in "Usage accounting: reap waits for the process group", and runners of different kinds SHALL reap their launches at the same time.

#### Scenario: Five groups that ignore SIGTERM
- **WHEN** five launch groups whose members ignore SIGTERM are reaped together with a kill grace of 500 ms
- **THEN** the five SIGTERMs land less than 500 ms apart, the reap returns no sooner than 500 ms and in less than 2000 ms, and no process of the five groups is left
