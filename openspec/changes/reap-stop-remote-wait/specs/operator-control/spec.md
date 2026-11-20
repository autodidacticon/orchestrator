## MODIFIED Requirements

### Requirement: Shutdown: reap before the verifier wait
A reaping shutdown SHALL reap the live launches as soon as the tick in flight has ended, before it waits for the prepare commands it aborts and for the verifier job in flight. A local verifier job in flight SHALL still run to its end, or until the shutdown deadline. A remote run that waits for a result SHALL end at once, as verifier-pool "Remote verification and restarts: stop" says.

#### Scenario: A verifier job in flight
- **WHEN** T4's local verifier job is in flight while T1, T2 and T3 run and the daemon stops with reap
- **THEN** the three launches are reaped and ended with reason `reaped` while the job is still running, and the stop completes only after the job ends

#### Scenario: A remote run waiting for a result
- **WHEN** under `verifier.mode: remote` T4's run waits for a result while T1, T2 and T3 run and the daemon stops with reap
- **THEN** the three launches are reaped and ended with reason `reaped`, and then T4's wait ends at once without recording a result and its job row is unchanged
