## ADDED Requirements

### Requirement: Configuration route: a change that would end a live launch
`PUT /v1/config` SHALL refuse with 409 a patch that would end a live launch, unless the body holds `endLive: true` (or `"true"`). A patch would end a launch when, for a `live` launch that holds the lease of a `running` task, the limits in force after the patch end it now and the limits in force before the patch do not. Two limits end a launch: `budgets.maxLaunchMs`, which ends it when its elapsed time is at or above the limit, and `health.stuckFailAfterMs`, which ends it when its idle time is above the limit; a limit of 0 ends nothing. The route SHALL take the elapsed and idle times, and SHALL compare them, through the same functions the time budget and stuck checks use, so time the daemon did not run is left out in both places. A changed `health.stuckAfterMs` only flags a launch and SHALL never be refused. The rule SHALL cover every shape of patch: a lower value, a null leaf that clears a raise, a null `budgets` or `health` block, and a limit that was 0 and is switched on. The route SHALL read the store only: it SHALL NOT ask the runner for liveness, so it can name a launch the next tick would not end. A `waiting` task's launch SHALL NOT be named. The route SHALL name only launches the new limits end now; a value below the age a young launch will reach SHALL be accepted.

The refusal body SHALL be `{ ok: false, error, wouldEnd }`, where each `wouldEnd` entry is `{ taskId, launchId, limit, value, elapsedMs }` for `budgets.maxLaunchMs` or `{ taskId, launchId, limit, value, idleMs }` for `health.stuckFailAfterMs`, `value` being the limit the patch would put in force, with one entry per launch and limit. `error` SHALL be one sentence that names each task and the `endLive` option. Nothing of the patch SHALL be applied, other keys included, and no `operator.config` event SHALL be appended. A patch that is invalid (the stuck pair rule included) SHALL be answered 400 first, and a start-only key SHALL be answered with its 409 and `startOnly` body before this check.

`endLive` SHALL NOT be a configuration key: it SHALL NOT be stored, validated as part of the patch, or listed under `applied`. With `endLive: true` the patch SHALL be applied as without the guard, the `operator.config` event SHALL record `endLive: true`, and the next tick ends the named launches. A body of `endLive` alone SHALL be answered 200 with `applied: []` and SHALL store nothing. `orchestrator-ctl config --end-live` SHALL add `endLive: true` to the PUT, and with no key SHALL send the PUT, not the GET; its usage SHALL name `--end-live`. The guard SHALL cover the route only: a daemon spawned with `--set`, and a changed file, apply their limits on the first tick. The `start` tool SHALL NOT take `endLive`; on a running daemon a refused limit lands under `rejected` with the route's `error` text.

#### Scenario: A lowered time budget is refused
- **WHEN** a launch of a running task is at 9000 ms elapsed under a budget of 10000 and `PUT /v1/config` carries `{ budgets: { maxLaunchMs: 5000 } }`
- **THEN** the answer is 409 with `wouldEnd: [{ taskId, launchId, limit: "budgets.maxLaunchMs", value: 5000, elapsedMs: 9000 }]` and an `error` naming the task and `endLive`, the stored document is unchanged, and the task is still `running` after a tick

#### Scenario: A lowered stuck fail limit is refused, a lowered flag limit is not
- **WHEN** a launch is idle for 2000 ms under limits 1000 and 3000 and the patch is `{ health: { stuckFailAfterMs: 1500 } }`
- **THEN** the answer is 409 with an entry `limit: "health.stuckFailAfterMs"`, `value: 1500` and `idleMs: 2000`; and the patch `{ health: { stuckAfterMs: 500 } }` for the same launch is applied

#### Scenario: The confirmed change
- **WHEN** the refused patch is sent again with `endLive: true`
- **THEN** it is answered 200 with `applied` holding `budgets`, the `operator.config` event holds `endLive: true`, the stored document holds no `endLive` key, and the next tick ends the launch with reason `timeBudget`

#### Scenario: Clearing a raise
- **WHEN** a boot budget of 10000 was raised to 0, a launch runs past 15000 ms, and the patch is `{ budgets: { maxLaunchMs: null } }` or `{ budgets: null }`
- **THEN** the answer is 409 naming that launch and the value in force stays 0; once the launch has submitted, the same clear is applied and the leaf is `{ value: 10000, source: "file" }`

#### Scenario: A limit switched on
- **WHEN** under a boot budget of 0 a launch is at 15000 ms elapsed and the patch is `{ budgets: { maxLaunchMs: 10000 } }`
- **THEN** the answer is 409 naming the launch

#### Scenario: The boundary follows the checks
- **WHEN** a launch's elapsed time equals the new `budgets.maxLaunchMs`, and its idle time equals the new `health.stuckFailAfterMs`
- **THEN** the first is listed in `wouldEnd` and the second is not

#### Scenario: Never refused
- **WHEN** the patch is `{ capacity: 3 }`, a raise, or leaves both ending limits in force unchanged, or the only launch past the new limits belongs to a `waiting` task
- **THEN** it is not refused for live launches

#### Scenario: Nothing applied on a refusal
- **WHEN** `{ capacity: 3, budgets: { maxLaunchMs: 5000 } }` is refused for a live launch
- **THEN** `capacity` keeps its value

#### Scenario: endLive alone
- **WHEN** the body is `{ endLive: true }`
- **THEN** the answer is 200 with `applied: []` and the stored document is unchanged and holds no `endLive` key

#### Scenario: The command line
- **WHEN** `orchestrator-ctl config --set budgets.maxLaunchMs=1` is run while a launch is live
- **THEN** the 409 with `wouldEnd` is relayed; with `--end-live` the change is applied
