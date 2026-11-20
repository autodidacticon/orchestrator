## ADDED Requirements

### Requirement: Shutdown: launches reaped together
A reaping shutdown SHALL reap the live launches that no worker holds in one call to the runner, so its wait for their processes does not grow with their number. After that call it SHALL take each launch in turn and record its usage, move its task as "Shutdown" states, and end the launch with reason `reaped`, in that order.

#### Scenario: Three launches whose agents ignore SIGTERM
- **WHEN** T1, T2 and T3 run agents that ignore SIGTERM and the daemon stops with reap under a kill grace of 500 ms
- **THEN** the three agents receive SIGTERM less than 500 ms apart, no process of their groups is left, and each launch is `ended` with reason `reaped` and the usage its agent printed after the signal

#### Scenario: Five launches before the deadline
- **WHEN** a daemon started with `--reap-on-exit` has five live launches whose agents ignore SIGTERM and receives SIGTERM
- **THEN** it exits 0 within its 8 s shutdown deadline, with an exit record of `reason: "signal"` and `reap: true`, and all five launches are `ended` with reason `reaped`

### Requirement: Shutdown: reap before the verifier wait
A reaping shutdown SHALL reap the live launches as soon as the tick in flight has ended, before it waits for the prepare commands it aborts and for the verifier job in flight. The verifier job in flight SHALL still run to its end, or until the shutdown deadline.

#### Scenario: A verifier job in flight
- **WHEN** T4's verifier job is in flight while T1, T2 and T3 run and the daemon stops with reap
- **THEN** the three launches are reaped and ended with reason `reaped` while the job is still running, and the stop completes only after the job ends
