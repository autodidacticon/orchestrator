## ADDED Requirements

### Requirement: Work workflow heartbeat interval
The work workflow's claimer SHALL return the claim's `lease.ttlMs` and `lease.renewEveryMs`. The worker prompt SHALL state both, and SHALL say that only the worker's own calls renew its lease. It SHALL say to call `launch_heartbeat` at least every `renewEveryMs`. It SHALL say to run any command expected to take longer in the background, heartbeating while it runs. The numbers SHALL come from the claim. Without them the prompt SHALL give a rule with no number.

#### Scenario: Prompt names the claimed interval
- **WHEN** a loop claims a launch whose response carries `lease: { ttlMs: 600000, renewEveryMs: 200000 }`
- **THEN** the worker prompt says the lease lasts 600000ms, to call `launch_heartbeat` at least every 200000ms, and to run longer commands in the background

### Requirement: Work loop renews the lease
While a claimed launch's agent process lives, `orchestrator-work` SHALL call `POST /v1/launches/:id/renew` with the launch token every `renewEveryMs` from the claim (else a third of `leaseTtlMs`), with one request in flight. It SHALL stop when the process exits, is ended by the watcher, or fails to spawn. It SHALL stop for good on 401, 404 or 409. A network error SHALL be a missed beat. A claim without lease facts SHALL start no renewal.

#### Scenario: A silent agent keeps its launch
- **WHEN** the loop runs an agent that writes nothing and calls nothing under `leaseTtlMs: 1500` and `--max-silence-ms 6000`
- **THEN** the daemon does not expire the launch; the loop ends the agent at its silence limit and releases the launch (`endReason: "released"`) no sooner than 6000ms after the claim, and the launch's `progressAt` is still its claim time

#### Scenario: A killed loop's claim expires
- **WHEN** the loop process is killed with SIGKILL while its detached agent still runs
- **THEN** the daemon ends the launch with `leaseExpired` within `leaseTtlMs` plus a tick, with margin for load, and the attempt is spent because nothing in the worktree changed

#### Scenario: Renewal stops on refusal
- **WHEN** a renewal answers 401, 404 or 409
- **THEN** the loop sends no further renewal for that launch

### Requirement: Work loop preamble states the interval
The preamble that `orchestrator-work` feeds the agent SHALL state the lease TTL and `renewEveryMs` from the claim. It SHALL say to call an orchestrator tool at least that often and to run longer commands in the background, calling `heartbeat` while they run. It SHALL also say that the loop's renewal keeps the lease but is not progress. Without lease facts in the claim it SHALL carry no lease line.

#### Scenario: Preamble names the claimed interval
- **WHEN** the claim carries `lease: { ttlMs: 600000, renewEveryMs: 200000 }`
- **THEN** the preamble says the lease is 600000ms and to call at least every 200000ms

## MODIFIED Requirements

### Requirement: Work loop ends a hung agent
While an agent runs, the work loop SHALL read its launch from `GET /v1/status` every `--poll-ms` and SHALL end the agent's process group (SIGTERM, then SIGKILL after 5 s), logging the reason, when the daemon has ended the launch; when its task reported 30 s ago and the agent has not exited; or when its task is running and the agent has written nothing for longer than the silence limit. Silence SHALL NOT be counted while the task waits on an answer.

#### Scenario: Ended launch
- **WHEN** the worker no longer holds the launch and its task is neither submitted nor done (failed, stuck, lease expired, cancelled, released, or relaunched on another launch)
- **THEN** the loop ends the agent's process group, sending SIGKILL after 5 s even when the shell has already exited

#### Scenario: Daemon unreachable
- **WHEN** `GET /v1/status` fails while the agent runs
- **THEN** only the silence limit applies

#### Scenario: The daemon expires a silent claim
- **WHEN** the claimed agent never writes and never exits, so the loop keeps renewing its lease, and the daemon fails the launch `stuck` (or `leaseExpired`, when the renewals could not reach it) and relaunches the task
- **THEN** the loop logs that the daemon ended the launch, ends the agent's process group, and claims the relaunch

#### Scenario: An agent that reported keeps its last output
- **WHEN** the agent submits and the daemon ends the launch `reported` while the agent is still printing its final events
- **THEN** the loop does not end it for 30 s, so its usage is posted with `usageSource: "worker"`

#### Scenario: Waiting is not silence
- **WHEN** the agent is blocked on a question for longer than the silence limit
- **THEN** the loop does not end it

### Requirement: Work loop after ending an agent
After an agent the loop ended has exited, the loop SHALL post its usage as for any exit and SHALL NOT classify its output as a start failure. It SHALL release the launch without keep, with a reason naming the termination, when the worker still holds it, and SHALL NOT release a launch the daemon ended. The outcome SHALL be `hung`, counted toward `--max-failures`, except after a report, when it SHALL be `started`. The loop SHALL then claim again.

#### Scenario: The daemon's verdict stands
- **WHEN** the loop ends an agent whose launch the daemon failed `stuck`
- **THEN** no `operator.release` is recorded for that launch and the outcome is `hung`

#### Scenario: A model that always hangs
- **WHEN** `--max-failures` launches in a row end with the outcome `hung`
- **THEN** the loop stops
