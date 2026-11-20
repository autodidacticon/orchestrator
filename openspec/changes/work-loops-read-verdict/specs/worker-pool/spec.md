## MODIFIED Requirements

### Requirement: Worker loop
The `orchestrator-worker` bin (`dist/src/worker/loop.js`) SHALL run the remote worker loop against the daemon at `ORCH_API`, which is required. Each round SHALL `POST /v1/claims` with `{ workerId, access: 'remote' }`. A 200 SHALL be worked as one launch (see "Clone cache", "Agent command", "Scripted agent" and "Fallback relay") and the loop SHALL claim again. Heartbeats from the loop, pod termination and usage are not part of this requirement.

#### Scenario: Two loops work a chain
- **WHEN** a remote run with a bare origin has the chain T1 -> T2 -> T3 and two loops with ids `w-1` and `w-2` run the scripted agent with separate caches
- **THEN** all three tasks become `done`, origin's integration branch carries one `Orchestrator-Task` trailer per task, `/v1/status` reports `finished`, both loops exit 0, and each loop's stdout has one `report accepted` line per task it claimed, three in all

#### Scenario: Backoff with nothing claimable
- **WHEN** every claim answers 404, the status is not finished and the verdict for the worker's kinds is never `standby`, with `ORCH_WORKER_IDLE_EXIT_MS` 120000
- **THEN** the loop waits 1, 2, 4, 8, 16, 30, 30 and 30 s and then exits 0 with an `idle-exit` line

#### Scenario: Finished run
- **WHEN** a claim answers 404 and `/v1/status` says `finished: true`
- **THEN** the loop prints a `finished` line and exits 0

### Requirement: Worker loop: nothing claimable
On a 404 (nothing claimable, or paused) or a 409 the loop SHALL read `GET /v1/status` and exit 0 when it says `finished`; otherwise it SHALL exit 0 once its idle clock, which a claim or the work verdict restarts, reaches `ORCH_WORKER_IDLE_EXIT_MS` (default 0: never), else wait before the next claim. The wait between claims SHALL start at `ORCH_WORKER_BACKOFF_MS` (default 1000), double after each wait up to `ORCH_WORKER_BACKOFF_MAX_MS` (default 30000), and reset to the first value after a claim.

#### Scenario: No idle exit by default
- **WHEN** every claim answers 404, the status is not finished, and `ORCH_WORKER_IDLE_EXIT_MS` is unset
- **THEN** the loop does not exit for idleness: it keeps claiming, and every wait after the fifth is 30 s

#### Scenario: Backoff reset after a claim
- **WHEN** the loop has waited 1, 2 and 4 s and then claims a launch
- **THEN** the next wait with nothing claimable is 1 s again

## ADDED Requirements

### Requirement: Worker loop: nothing claimable: work verdict
The status read SHALL take the strongest (`strongestVerdict`) of `workByKind.<kind>.verdict` over the loop's `ORCH_WORKER_RUNNER` kinds, else every kind. On `finished` the loop SHALL exit 0. On `standby` it SHALL restart its idle clock. `claim`, `human`, `stalled`, `paused` and `idle` SHALL only let the clock run; only a claim that succeeds resets it. A loop with `ORCH_WORKER_TASK` SHALL read only `finished` and keep the plain idle limit.

#### Scenario: Standby holds the idle limit off
- **WHEN** `ORCH_WORKER_IDLE_EXIT_MS` is 120000 and every status answers `standby` for 600 s, then `human`
- **THEN** the loop is still running after 600 s and exits 0 with `idle-exit` 120 s after the last `standby`; likewise for `stalled`, `paused`, `idle`, and `claim` while every claim answers 404

#### Scenario: Task filter keeps the plain limit
- **WHEN** a loop with `ORCH_WORKER_TASK` and `ORCH_WORKER_IDLE_EXIT_MS` 120000 reads `standby` on every status
- **THEN** it exits 0 with `idle-exit` after 120 s, and at once with `finished` when the verdict is `finished`

#### Scenario: Only the loop's kinds count
- **WHEN** a loop with the kinds `codex` and `opencode` reads `standby` for `claude-code` and `idle` for its own kinds
- **THEN** the idle clock runs; a loop with no runner filter takes the strongest verdict of the three kinds

### Requirement: Worker loop: nothing claimable: status without a verdict
A status body without a verdict for any of the loop's kinds (an older daemon) SHALL be read for `finished` alone, and the idle clock SHALL run as before.

#### Scenario: Older daemon
- **WHEN** every claim answers 404 and the status is `{ finished: false }` with `ORCH_WORKER_IDLE_EXIT_MS` 120000
- **THEN** the loop exits 0 with `idle-exit` after 121 s, and with `finished` once the status says `finished: true`
