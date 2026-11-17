## ADDED Requirements

### Requirement: Limits read at every check
The stuck check and the launch time budget check SHALL read `health.stuckAfterMs`, `health.stuckFailAfterMs` and `budgets.maxLaunchMs` from the effective configuration (the boot resolution with the stored override document applied) each time they test a launch, so a change applies on the next tick to every live launch, spawned or claimed. Idle and elapsed time are measured as "Stuck detection and escalation", "Launch time budget" and "Gap in the daemon's clock" state; only the limit they are compared with follows the override. A raised limit SHALL keep a launch that has not yet crossed it; a lowered or cleared limit SHALL apply at once. A launch already flagged stuck SHALL stay flagged until progress clears it, also after `health.stuckAfterMs` is raised. A change that lands while the tick is already ending a launch does not save it.

#### Scenario: A raised time budget saves a spawned launch
- **WHEN** a spawned launch has run 9500 ms under a `budgets.maxLaunchMs` of 10000, the override `budgets: { maxLaunchMs: 20000 }` is applied, and a tick runs 1000 ms later
- **THEN** the task is still `running`; a tick after the launch has run past 20000 ms ends it with reason `timeBudget`

#### Scenario: A raised time budget saves a claimed launch
- **WHEN** a claimed launch in `pull` mode is 9500 ms old under a budget of 10000, the same override is applied, and a tick runs 1000 ms later
- **THEN** the task is still `running`

#### Scenario: A raised fail limit saves a silent launch, which stays flagged
- **WHEN** with limits 1000 and 3000 a launch idle for 2500 ms is flagged stuck, `health: { stuckFailAfterMs: 6000 }` is applied, and a tick runs 1000 ms later
- **THEN** the task is `running` and the launch is still flagged stuck; once it has been idle for more than 6000 ms a tick fails it with reason `stuck` and `attempts` 1

#### Scenario: A raised flag limit leaves the flag
- **WHEN** a flagged launch makes no progress and `health.stuckAfterMs` is raised above its idle time
- **THEN** it stays in `status.stuck` and no second `launch.stuck` event is appended

#### Scenario: Zero at runtime
- **WHEN** `health: { stuckFailAfterMs: 0 }` is applied and a launch stays silent past the old fail limit
- **THEN** it is not failed
