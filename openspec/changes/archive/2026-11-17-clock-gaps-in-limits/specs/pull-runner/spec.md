## ADDED Requirements

### Requirement: Lease renewal after a gap
Each write of gaps (health-monitoring "Gap in the daemon's clock") SHALL renew, in the same transaction, the lease of every live launch that holds the lease of a `running` or `waiting` task, to expire at the time of the write plus `leaseTtlMs`. The renewal SHALL NOT be a progress signal: it SHALL leave `progressAt`, `lastSignal`, `progressText` and `stuckSince` unchanged and SHALL append no `launch.unstuck` and no `launch.notice`. The tick SHALL write pending gaps before it tests any lease against the clock it reads in the reconcile phase, and the lease-expiry test of a claimed launch SHALL note the clock and write pending gaps before each test, so no lease is expired while a noted gap is unwritten. This excepts pull-runner "Lease renewal by the work loop" scenario "Renewal stops" and health-monitoring "Process liveness" scenario "Unknown liveness falls back to the lease": a gap after the last contact lengthens the time to expiry by up to the gap plus a TTL.

#### Scenario: A claimed launch survives a sleep between ticks
- **WHEN** a claimed launch in `pull` mode makes no call and the machine sleeps for five TTLs between two ticks
- **THEN** the tick at the wake leaves it live with `attempts` unchanged, its lease expires at or after the wake plus `leaseTtlMs`, and `progressAt` and `lastSignal` are unchanged; after a further TTL plus one tick without a call it ends with `leaseExpired`

#### Scenario: A spawned launch of unknown liveness survives a sleep
- **WHEN** the runner reports `unknown` for a running spawned launch and the machine sleeps for five TTLs
- **THEN** the tick at the wake leaves it live with `attempts` unchanged, and it is failed with reason `leaseExpired` only after a further TTL without contact

#### Scenario: A sleep inside the tick before the lease test
- **WHEN** the machine sleeps for five TTLs while the tick awaits the graph source, before the reconcile phase reads the clock
- **THEN** a claimed launch and a spawned launch of unknown liveness are both live after that tick with `attempts` unchanged
