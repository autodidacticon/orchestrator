## MODIFIED Requirements

### Requirement: Exit record
On every graceful exit, whether by the `shutdown` route, by signal, or by idle exit, the daemon SHALL write `exit: { at, reason, reap, digest, by?, unflushedBatches?, storeClosed?, rejected? }` into `daemon.json` after the orchestrator has stopped and before the process ends. `reason` is `stop`, `signal`, or `idle`. `digest` is the event-stream digest taken before the store closes. `by`, present for a `stop`, names the caller as recorded by the `shutdown` route.

The record SHALL be written after the store's close returns. When the close reports lost batches, the record SHALL carry their count as `unflushedBatches`. When the sink rejected a batch, the record SHALL carry its cause as `rejected`. When the shutdown grace period elapses before the close returns, the record SHALL carry `storeClosed: false` and `unflushedBatches` set to the pending count read before the record is written, even when that count is 0. When the journal turns fatal after a shutdown began and before the close returns, the record SHALL carry `storeClosed: false` and the fatal condition's `unflushedBatches` before the daemon exits 1. A fatal condition with no shutdown under way leaves no record and reads as a crash. A record without these fields is clean. A clean record SHALL be written only after the store closed with nothing unflushed.

A daemon that starts SHALL write `daemon.json` without `exit`. A dead pid whose `daemon.json` has no `exit` SHALL be read as a crash. `runs` SHALL report, for every run whose daemon is not alive, the exit record or that none exists. The revival refusal after a `stop` SHALL name the caller when one was recorded, and SHALL name the lost batches when the record is not clean.

#### Scenario: Stop records the reason
- **WHEN** the daemon is stopped through the `shutdown` route with `reap` false
- **THEN** `daemon.json` carries `exit` with reason `stop`, `reap` false, the digest, and `by` with the caller's remote address, and no `unflushedBatches` or `storeClosed`

#### Scenario: Crash leaves no record
- **WHEN** the daemon is killed with SIGKILL
- **THEN** `runs` lists the run as not alive with no exit record

#### Scenario: Restart clears the record
- **WHEN** a daemon that exited idle is started again
- **THEN** `daemon.json` has no `exit` while it runs

#### Scenario: Exit that lost batches
- **WHEN** the database session stops answering, a write is committed, and the daemon receives SIGTERM
- **THEN** the daemon exits 1, and `exit` carries reason `signal` and `unflushedBatches` equal to the count the daemon logged

#### Scenario: Revival refusal names the loss
- **WHEN** the exit record is a `stop` with `unflushedBatches: 3` and an operation asks for revival
- **THEN** the refusal reads `stop, losing 3 unflushed batches`
