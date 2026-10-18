## MODIFIED Requirements

### Requirement: Usage accounting
When a launch is observed dead or is ended, the daemon SHALL ask the runner for the launch's usage. `ClaudeCodeRunner.readUsage` SHALL parse the last JSON object in the launch log for `total_cost_usd`, `duration_ms`, and `num_turns`; a log without such an object SHALL yield no usage, and the scripted and in-process runners SHALL yield none unless scripted. Usage found SHALL be stored on the launch row as `costUsd`, `turns`, and `durationMs` and appended as `launch.usage`. The cost of a task SHALL be the sum over its launches and the cost of the run the sum over all launches, both derived from launch rows so that a restart cannot double count. Because a headless agent writes its usage only when it exits, the daemon SHALL record `reportedAt` on the launch when a submit is accepted and SHALL leave a live launch whose task is `submitted` or `done` running while its process is alive and the report is younger than `health.reportGraceMs` (default 30000; 0 disables the grace); when the process exits or the grace elapses, the daemon SHALL record usage, reap what remains, end the launch with reason `reported`, and remove its worktree. Cancelled and superseded launches SHALL be reaped at once as before. A lingering launch delays the idle exit by at most the grace.

#### Scenario: Claude log tail parsed
- **WHEN** a launch log ends with the JSON object `claude -p --output-format json` prints, preceded by stderr lines
- **THEN** the launch row records `costUsd`, `turns`, and `durationMs` from `total_cost_usd`, `num_turns`, and `duration_ms`

#### Scenario: Log without JSON
- **WHEN** a launch log contains no JSON object
- **THEN** no usage is recorded and the launch's cost is unknown

#### Scenario: Cost survives restart
- **WHEN** two launches with recorded cost exist and the daemon restarts
- **THEN** `status` reports the same run cost and per-task costs as before

#### Scenario: Submitted launch exits on its own within the grace
- **WHEN** T1 submits, its process stays alive for a few seconds and then exits, and the grace is 30 s
- **THEN** the launch is still `live` on the tick after the submit, and on the tick after the exit it ends with reason `reported` and carries the usage from its log

#### Scenario: Grace elapses
- **WHEN** T1 submits and its process is still alive when `health.reportGraceMs` has elapsed
- **THEN** the daemon records whatever usage the log holds, reaps the process, and ends the launch with reason `reported`

#### Scenario: Grace disabled
- **WHEN** `health.reportGraceMs` is 0 and T1 submits
- **THEN** the launch ends with reason `reported` on the next tick, as before
