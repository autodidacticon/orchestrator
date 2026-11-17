## ADDED Requirements

### Requirement: Failed check across a gap

A verifier run that ends `failed` with kind `checkFailed` or `checkTimeout`, or that throws, and whose run overlapped a gap in the daemon's clock SHALL be put back to `queued` instead of `failed`, once per job. No attempt SHALL be spent and the task SHALL stay `submitted`. The run overlapped a gap when the daemon's awake time between the run's start and the outcome's arrival is less than the wall time between them; both instants SHALL be read after a note of the clock, from the daemon's own gap list (specs/health-monitoring "Gap in the daemon's clock"), and the verifier SHALL keep no clock of its own. In one store transaction the daemon SHALL append `verify.requeued` with `jobId`, a `reason` naming the gap and the failure kind, and `gap: { failureKind, gapMs }`, where `gapMs` is the wall time less the awake time, and SHALL reset the job's `expectedHead`, `rebasedSha`, `verifiedSha` and `squashSha` as a `requeue` outcome does and set its `gapRequeues` to 1. Push retry state SHALL NOT change. The count SHALL be kept on the job row and SHALL NOT be cleared when the job is re-queued for another reason. A failure of a job whose `gapRequeues` is 1 SHALL be written `failed` as before, gap or no gap. The re-run SHALL start like any queued job, after the hold that follows the gap (specs/health-monitoring "Hold after a gap"). A `conflict`, `published` or `requeue` outcome, another failure kind, a dropped job and a fatal store SHALL be handled as before, and `checkTimeoutMs` SHALL still count wall time. With `health.gapAfterMs` at 0 there are no gaps and this rule re-queues nothing. "Check and verified tree" is unchanged.

#### Scenario: A check times out across a gap

- **WHEN** the machine sleeps longer than `health.gapAfterMs` while a check runs and the run ends `failed` with kind `checkTimeout`
- **THEN** the job is `queued` with `gapRequeues` 1 and no `rebasedSha`
- **AND** one `verify.requeued` event carries the job id and `gap: { failureKind: checkTimeout, gapMs }` with a positive `gapMs`
- **AND** the task is `submitted` with no attempt spent, and the job runs again after the hold

#### Scenario: The re-run fails across a second gap

- **WHEN** the job re-queued after a gap runs again and fails across a second gap
- **THEN** the task fails by `verificationFailed` and spends an attempt
- **AND** no second `verify.requeued` event with `gap` is appended

#### Scenario: A failure without a gap

- **WHEN** a check run during which the daemon's clock had no gap ends `failed`, including a run that began after a gap had ended
- **THEN** the task fails by `verificationFailed` and spends an attempt, and no `verify.requeued` event is appended
