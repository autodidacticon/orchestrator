## ADDED Requirements

### Requirement: Prepare failure limit
The system SHALL count the prepare failures of each task in a row, as "Prepare failure" defines them, in one kv entry `prepareRetry`: a JSON object from task id to `{ failures, retryAt, last }`, `last` being `exit <code>`, `timeout`, `killed`, `spawn` or `dirty`. A failure SHALL be counted only when the task still runs on the failed launch; a cancel, a cascade reset, a stop or a crash during a command counts nothing, and a failure whose run overlapped a machine sleep counts like any other. The count SHALL be read and written inside the transaction that applies the failure.

Below `prepareFailureLimit` (a top-level file key read at start, positive integer, default 3) the task SHALL return to `unstarted` as "Prepare failure" says, and SHALL be admitted again only at `retryAt`: the failure time plus `prepareRetryBackoffMs` (a top-level file key read at start, non-negative integer, default 30000) times 2 to the power of the earlier failures, the factor capped at 32. The wait SHALL count wall time and SHALL go on during a pause. A task before its `retryAt` SHALL NOT be a candidate for admission and SHALL hold no capacity slot. Nothing wakes the loop at `retryAt`: the task is admitted on the first tick at or after it.

When `failures` reaches `prepareFailureLimit` the orchestrator SHALL apply `running -> blocked` with trigger `prepareFailed` and reason kind `prepareFailed`, attempts and carry unchanged, and remove the task's entry. The message SHALL be `` prepare command `<command>` failed <n> times in a row; last: <reason> `` and SHALL carry no command output; the output stays in `launch.prepareFailed` and the daemon log.

`launch.prepareFailed` SHALL carry `failures` and `limit` when the failure is counted, and `retryAt` when the task is not blocked.

The entry of a task SHALL be removed when its prepare command succeeds (in the transaction that appends `launch.prepared`), when it is blocked at the limit, and by every transition of it with trigger `unblock`, `reopen`, `uncancel` or `cascade`. A cancel alone SHALL leave it; the uncancel removes it. A task the cascade does not reset, such as an `unstarted` dependent of the reopened task, SHALL keep its entry. The store has no kv delete: an emptied object is stored as `''`, which reads as no entries.

Per operator-control "Idle exit", a retry entry whose id is a task node of the loaded graph that is `unstarted` SHALL keep the daemon from being quiescent, whatever its `retryAt` says. An entry for an id that is not a task node of the loaded graph SHALL NOT.

With `prepareCommand` unset the entry SHALL never be read or written.

#### Scenario: First failure is counted
- **WHEN** the prepare command of a task's first launch exits 1 under the defaults
- **THEN** `launch.prepareFailed` carries `failures` 1, `limit` 3 and `retryAt` the failure time plus 30000, the task is `unstarted` with `attempts` unchanged, and its entry holds the same `failures` and `retryAt`

#### Scenario: Doubling backoff
- **WHEN** the task is launched again at `retryAt` and its command fails again
- **THEN** no launch was created for it before `retryAt`, and the new `retryAt` is the failure time plus 60000

#### Scenario: A waiting task holds no slot
- **WHEN** capacity is 1 and a task waits out its retry while another task is ready
- **THEN** the other task is launched

#### Scenario: Block at the limit
- **WHEN** the third failure in a row of a task is applied under the defaults
- **THEN** the task is `blocked` with reason kind `prepareFailed`, attempts unchanged, the message names the command, the count and the last reason and holds no output, the event carries `failures` 3 and no `retryAt`, and the task has no entry

#### Scenario: Reset by a success
- **WHEN** a task's command fails, then succeeds, then fails
- **THEN** the last failure has `failures` 1

#### Scenario: Reset by an uncancel
- **WHEN** a task with an entry is cancelled and then uncancelled
- **THEN** the cancel leaves the entry, the uncancel removes it, and the task is admitted on the next tick without waiting for the old `retryAt`

#### Scenario: Cascade
- **WHEN** a cascade reopen resets a task whose command runs, and another task waits out its retry as an `unstarted` dependent of a reopened task
- **THEN** the reset task has no entry and the waiting task keeps its entry

#### Scenario: Not quiescent while a retry waits
- **WHEN** a task with an entry is `unstarted`, before or after its `retryAt`
- **THEN** the daemon is not quiescent; once the task is cancelled or blocked, or when the entry names no task of the graph, the entry does not count

#### Scenario: Limit 1 and backoff 0
- **WHEN** `prepareFailureLimit` is 1, or `prepareRetryBackoffMs` is 0
- **THEN** the first failure blocks the task and writes no entry, or the task is admitted again in the same tick that applies the failure
