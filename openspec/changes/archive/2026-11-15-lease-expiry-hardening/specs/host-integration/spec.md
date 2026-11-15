## MODIFIED Requirements

### Requirement: Work loop renews the lease
While a claimed launch's agent process lives, `orchestrator-work` SHALL call `POST /v1/launches/:id/renew` with the launch token every `renewEveryMs` from the claim (else a third of `leaseTtlMs`), with one request in flight. It SHALL stop when the agent process exits, even while another process (a grandchild) still holds its output pipes, and when the process fails to spawn. While the watcher is ending the agent's process group, the loop SHALL renew until the group is gone, so that it can release the launch itself. It SHALL stop for good on 401, 404 or 409. A network error SHALL be a missed beat. A claim without lease facts SHALL start no renewal.

#### Scenario: A silent agent keeps its launch
- **WHEN** the loop runs an agent that writes nothing and calls nothing under `leaseTtlMs: 1500` and `--max-silence-ms 6000`
- **THEN** the daemon does not expire the launch; the loop ends the agent at its silence limit and releases the launch (`endReason: "released"`) no sooner than 6000ms after the claim, and the launch's `progressAt` is still its claim time

#### Scenario: A grandchild holds the pipe
- **WHEN** the agent exits without a report, leaving a grandchild that keeps its stdout open, under `leaseTtlMs: 1500` and `--max-silence-ms 20000`
- **THEN** the loop stops renewing at the exit, the daemon ends the launch with `leaseExpired` well before the silence limit, and the loop does not release it

#### Scenario: A killed loop's claim expires
- **WHEN** the loop process is killed with SIGKILL while its detached agent still runs
- **THEN** the daemon ends the launch with `leaseExpired` within `leaseTtlMs` plus a tick, with margin for load, and the attempt is spent because nothing in the worktree changed

#### Scenario: Renewal stops on refusal
- **WHEN** a renewal answers 401, 404 or 409
- **THEN** the loop sends no further renewal for that launch
