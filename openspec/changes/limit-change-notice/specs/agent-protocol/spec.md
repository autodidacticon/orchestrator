## ADDED Requirements

### Requirement: Limit change notice
When an accepted configuration patch changes the value in force of `budgets.maxLaunchMs`, `health.stuckAfterMs` or `health.stuckFailAfterMs`, the daemon SHALL queue one inbox notice to each affected launch: `{ kind: 'nudge', source: 'config', message, changed, limits }`. `changed` SHALL list the dotted names of the limits whose value in force changed. `limits` SHALL hold the three values now in force, nested like the config file: `{ budgets: { maxLaunchMs }, health: { stuckAfterMs, stuckFailAfterMs } }`. `message` SHALL state, for each changed limit, the old and the new value in milliseconds, SHALL say that 0 means the limit is off, and for the time budget SHALL give the launch's elapsed time, with time the daemon did not run left out as at the time budget check. The affected launches SHALL be every launch with status `live` or `launching` that holds the lease of a `running` or `waiting` task, and every launch with status `claimable`. The notices SHALL be queued in the store transaction that writes the override document, each with its `launch.notice` event; no other operator event SHALL be appended. A patch that changes no value in force of the three limits, a patch of any other key, and a refused patch SHALL queue nothing. The notice SHALL be delivered once, like any notice, and nothing in the daemon SHALL depend on it being read.

#### Scenario: A raised time budget reaches each live launch
- **WHEN** the operator sets `budgets.maxLaunchMs` from 10000 to 20000 while launches run
- **THEN** the next inbox call of each live launch returns exactly one notice with `kind: 'nudge'`, `source: 'config'`, `changed: ['budgets.maxLaunchMs']`, the three values in force under `limits`, and a message holding 10000, 20000 and the launch's elapsed time, and a `launch.notice` event exists for each

#### Scenario: The same value again
- **WHEN** the operator sets a limit to the value already in force, from an override, the file or the default
- **THEN** no notice is queued

#### Scenario: Two limits in one patch
- **WHEN** one patch changes `budgets.maxLaunchMs` and `health.stuckFailAfterMs`
- **THEN** each affected launch gets one notice whose `changed` lists both

#### Scenario: Parked and waiting launches
- **WHEN** a limit changes while a launch is `claimable` in pull mode and another launch's task is `waiting` on a question
- **THEN** both launches get the notice, and the parked launch returns it on its first inbox call after it is claimed; a launch that has ended gets none

#### Scenario: Another key or a refusal
- **WHEN** the patch changes only `capacity`, or is refused with 400, with the start-only 409 or with the `wouldEnd` 409
- **THEN** no notice is queued

#### Scenario: Written with the document
- **WHEN** a write in the transaction of an accepted patch fails after a notice was queued
- **THEN** neither the override document, the `operator.config` event nor any notice is stored
