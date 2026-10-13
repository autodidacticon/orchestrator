## ADDED Requirements

### Requirement: Cascade is resumable
The cascade plan and a pending-cascade marker SHALL be recorded in one transaction before any reset, each reset SHALL be its own transaction, and the marker SHALL be cleared in the transaction of the last reset. The code SHALL call `crashPoint('cascade.afterPlan')` between recording the plan and the first reset, and `cascade.afterPlan` SHALL be a named crash point. Recovery SHALL re-read the marker and apply every planned node that is still started, treating nodes already reset as done, and SHALL leave the processes and jobs of reset nodes to the existing recovery and sweep rules. After a crash at `cascade.afterPlan` or at any tick phase during a cascade, followed by a restart, the convergence invariants SHALL hold with trailer commits counted per published launch.

#### Scenario: Crash after the plan
- **WHEN** the daemon dies at `cascade.afterPlan` for a cascade over T2 and MVP and is restarted
- **THEN** recovery resets T2 and MVP before the first tick, T2's launch is ended with reason `cascade`, and the run converges to the same state as an uninterrupted cascade

#### Scenario: Crash mid-cascade
- **WHEN** the daemon dies after resetting MVP but before resetting T2 and is restarted
- **THEN** recovery resets T2 only, MVP is not reset a second time, and the marker is cleared
