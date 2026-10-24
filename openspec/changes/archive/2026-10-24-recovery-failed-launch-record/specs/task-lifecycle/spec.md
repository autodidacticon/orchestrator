## MODIFIED Requirements

### Requirement: Retry and exhaustion
When a task becomes `failed` and `attempts` is below `maxAttempts` (default 2), the orchestrator SHALL return it to `unstarted` and the next launch's brief MUST include the prior failure report and any verifier output. When `attempts` reaches `maxAttempts`, the orchestrator SHALL move the task to `blocked` with the last reason.

Every launch that dies without a report SHALL be recorded as a `launch.failed` event carrying the runner's `reason` and `detail` when it gave a diagnosis, and `charged`, whether the death is observed by a tick or by startup recovery. A death the runner diagnoses as `startupContended` SHALL NOT be charged while the task has had fewer than `health.contendedRetries` (default 3) uncharged contended deaths, counted from those events and never reset: the task SHALL return to `unstarted` at once through the orchestrator's `running -> unstarted` (`released`) transition, with `attempts` unchanged, the transition event carrying `reason: startupContended`, and the next brief carrying the `exitedWithoutReport` failure as the prior failure. The count SHALL be read in the same store transaction that appends the `launch.failed` event. Later contended deaths SHALL be charged like any other failure. `0` charges every one.

#### Scenario: Contended startups relaunch without charge
- **WHEN** a task's first two launches die and the runner diagnoses each as `startupContended`, and the third launch submits and is published
- **THEN** the task is `done` with `attempts` 0, and the two `launch.failed` events carry `reason: startupContended` and `charged: false`

#### Scenario: The allowance runs out
- **WHEN** a task's fourth launch dies `startupContended` with `health.contendedRetries` at 3
- **THEN** the death is charged: `attempts` is one and its `launch.failed` event carries `charged: true`

#### Scenario: Restart deaths share the allowance
- **WHEN** with `health.contendedRetries` at 1, a task's first launch dies `startupContended` while the daemon runs and its second dies `startupContended` while the daemon is down
- **THEN** recovery charges the second death: its `launch.failed` event carries `charged: true` and `attempts` is one

#### Scenario: One automatic retry with context
- **WHEN** a task fails on its first attempt
- **THEN** it is relaunched and the new brief contains the prior failure report

#### Scenario: Exhaustion blocks
- **WHEN** a task fails on its second attempt with `maxAttempts` at 2
- **THEN** it becomes `blocked` and appears in `stallRoots`
