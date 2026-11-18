## ADDED Requirements

### Requirement: Task filter and launch limit
The worker loop SHALL read two optional variables. `ORCH_WORKER_TASK`, when set to a non-empty value, SHALL be sent as `taskId` in every claim, so the worker claims only that task's launch; a claim answered 404 or 409 is waited on as any other. `ORCH_WORKER_MAX_LAUNCHES`, a non-negative integer, SHALL make the loop exit 0 once it has worked that many claimed launches to their end (a report accepted, a release, or an ended launch), without claiming again; unset or 0 SHALL mean no limit. A malformed `ORCH_WORKER_MAX_LAUNCHES` SHALL be refused at start, naming the variable, with exit 2. After the limit the loop SHALL print `worker <id> max-launches - -`.

#### Scenario: One task, one launch
- **WHEN** the loop runs with `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`
- **THEN** its claim is `{ workerId, access: 'remote', taskId: 'SMOKE' }`, and after that launch it prints `max-launches` and exits 0 without a second claim

#### Scenario: No filter
- **WHEN** neither variable is set
- **THEN** the claim names no `taskId` and the loop claims again after each launch

#### Scenario: Malformed limit
- **WHEN** `ORCH_WORKER_MAX_LAUNCHES` is `-1` or `one`
- **THEN** the settings are refused with an error naming `ORCH_WORKER_MAX_LAUNCHES`
