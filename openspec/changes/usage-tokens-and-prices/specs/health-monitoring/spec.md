## MODIFIED Requirements

### Requirement: Usage accounting
When a launch is observed dead or is ended, the daemon SHALL ask the runner named on the launch row for the launch's usage. Each runner SHALL read its own log: the Claude Code runner SHALL parse the last JSON object in the launch log for `total_cost_usd`, `duration_ms`, `num_turns`, and the `usage` object's `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`; other runners SHALL read the token counts their CLI reports. A log without usage SHALL yield no usage, and the scripted and in-process runners SHALL yield none unless scripted. Usage SHALL carry `tokens` as `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` in the same shape for every runner (`cachedInput` counted inside `input`; Claude's cache reads are therefore added to its `input_tokens`) and `source` naming the reader. A usage with any of a cost, turns, a duration, or tokens SHALL be recorded, so a usage with only tokens is recorded. A usage with tokens and no cost SHALL be priced as "Run cost budget" states: billable input `input - cachedInput` at `inputPerMTok`, `cachedInput` at `cachedInputPerMTok` (fallback `inputPerMTok`), `cacheWriteInput` at `cacheWriteInputPerMTok` (fallback `inputPerMTok`), `output` at `outputPerMTok`, and `reasoningOutput` at `reasoningOutputPerMTok` (fallback `outputPerMTok`), per million tokens and rounded to 1e-6, under two assumptions, both assumed, unverified: Codex's `cached_input_tokens` is a subset of `input_tokens`, and `reasoning_output_tokens` is NOT included in `output_tokens`. Usage found SHALL be stored on the launch row as `costUsd`, `turns`, `durationMs`, `tokens`, `usageSource`, and `costSource` (see "Run cost budget"), and appended as `launch.usage` whose payload carries the whole usage. `durationMs` SHALL stay unset when the runner reports none; `status.liveLaunches[].elapsedMs` gives wall time. The cost and tokens of a task SHALL be the sums over its launches and those of the run the sums over all launches, all derived from launch rows so that a restart cannot double count. Because a headless agent writes its usage only when it exits, the daemon SHALL record `reportedAt` on the launch when a submit is accepted and SHALL leave a live launch whose task is `submitted` or `done` running while its process is alive and the report is younger than `health.reportGraceMs` (default 30000; 0 disables the grace); when the process exits or the grace elapses, the daemon SHALL record usage, reap what remains, end the launch with reason `reported`, and remove its worktree. These grace mechanics are unchanged by token accounting: Codex writes `turn.completed` with its usage after its final `agent_message` in every observed run. Cancelled and superseded launches SHALL be reaped at once as before. A lingering launch delays the idle exit by at most the grace.

#### Scenario: Claude log tail parsed
- **WHEN** a launch log ends with the JSON object `claude -p --output-format json` prints, preceded by stderr lines
- **THEN** the launch row records `costUsd`, `turns`, and `durationMs` from `total_cost_usd`, `num_turns`, and `duration_ms`, and `tokens` from the `usage` object, with `usageSource` `claude-code` and `costSource` `reported`

#### Scenario: Usage with only tokens
- **WHEN** a runner reports `tokens: { input: 40361, output: 260 }` and no cost, turns, or duration for T1
- **THEN** the launch row stores the tokens, exactly one `launch.usage` carrying them is appended, and `status.tokens.run` and `status.tokens.byTask.T1` sum them

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

### Requirement: Run cost budget
Config `budgets.maxRunCostUsd` (default 0) SHALL mean unlimited when 0. Config `budgets.prices` (default `{}`) SHALL map a model name (checked by the model-name pattern) to rates in USD per million tokens: `inputPerMTok`, `outputPerMTok`, and optional `cachedInputPerMTok`, `cacheWriteInputPerMTok`, and `reasoningOutputPerMTok`, each non-negative. When a runner reports a cost, the launch SHALL record it with `costSource: 'reported'` and SHALL NOT re-price it. When a runner reports tokens without a cost and `budgets.prices` has the launch's model, the daemon SHALL compute `costUsd` at record time with `costSource: 'priced'` as the sum of:
- `input - cachedInput` at `inputPerMTok`;
- `cachedInput` at `cachedInputPerMTok`, falling back to `inputPerMTok`;
- `cacheWriteInput` at `cacheWriteInputPerMTok`, falling back to `inputPerMTok`;
- `output` at `outputPerMTok`;
- `reasoningOutput` at `reasoningOutputPerMTok`, falling back to `outputPerMTok`;

each count divided by one million and the total rounded to 1e-6. Two assumptions about Codex's counts are assumed, unverified: `cached_input_tokens` is a subset of `input_tokens` (an observed 40361 input with 32128 cached is consistent), and `reasoning_output_tokens` is NOT included in `output_tokens`. When tokens are reported without a cost and the model has no price, the launch's cost SHALL stay unknown: it SHALL be excluded from the run cost and counted in `status.cost.unpricedLaunches` (launches whose row has `tokens` and no `costUsd`; a launch that ended with no usage at all is not counted), and the daemon SHALL log one warning per such model. The run cost, and so the ceiling, SHALL count priced and reported launches only; unpriced launches SHALL NOT pause admission. The ceiling SHALL be `maxRunCostUsd` times one plus the number of overrides recorded. When the run cost reaches the ceiling, admission SHALL pause with `pausedReason: 'costBudget'` and `budget.exceeded`, while running work and verification continue. `resume` SHALL be refused while the run cost is at or above the ceiling unless called with `overrideBudget`, which SHALL record `budget.overridden`, raise the ceiling by one budget, and lift the pause.

#### Scenario: Budget crossed pauses admission
- **WHEN** the budget is 5 USD, two finished launches cost 3 USD each, and three tasks are ready
- **THEN** the run is paused with `pausedReason` `costBudget`, `budget.exceeded` is appended, and no new launch starts

#### Scenario: Priced tokens cross the budget
- **WHEN** the budget is 5 USD, `budgets.prices` has the launches' model at 100 USD input and 1000 USD output per million tokens, and two finished launches each reported 40361 input and 260 output tokens with no cost
- **THEN** each row records `costUsd` 4.2961 with `costSource` `priced`, `unpricedLaunches` is 0, and the run is paused with `pausedReason` `costBudget`

#### Scenario: Unpriced tokens are visible but do not pause
- **WHEN** the budget is 5 USD and a finished launch reported tokens and no cost for a model with no price
- **THEN** its `costUsd` stays unset, `status.cost.runUsd` is 0, `status.cost.unpricedLaunches` is 1, and admission continues

#### Scenario: Reported cost is not re-priced
- **WHEN** a runner reports `costUsd` 0.5 with tokens for a model that has a price
- **THEN** the row records `costUsd` 0.5 with `costSource` `reported`

#### Scenario: Resume refused then overridden
- **WHEN** `resume` is called while the run cost is above the ceiling, then called again with `overrideBudget`
- **THEN** the first call is refused naming the cost and the ceiling, and the second records the override, lifts the pause, and raises the ceiling to 10 USD
