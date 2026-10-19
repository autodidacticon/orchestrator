## MODIFIED Requirements

### Requirement: Usage accounting
Usage SHALL have two sources, and the launch row and `launch.usage` SHALL name the source as `source`/`usageSource`. When a spawned launch is observed dead or is ended, the daemon SHALL ask the runner named on the launch row for the launch's usage. Each runner SHALL read its own log format:
- The Claude Code runner SHALL parse the last JSON object in the launch log for `total_cost_usd`, `duration_ms`, `num_turns`, and the `usage` object's `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`.
- The Codex runner SHALL sum the `usage` of every `turn.completed` line, as worker-runners "Codex usage parsing" states, and SHALL report no cost, turns, or duration.
- The OpenCode runner SHALL sum every `step_finish` line, as worker-runners "OpenCode usage parsing" states: cache reads folded into `input` as for Claude, the cost read from the stream as `costUsd`, `turns` the steps that ended with `reason: "stop"`, and no duration.
- The scripted and in-process runners SHALL yield no usage unless scripted.

A log without usage SHALL yield no usage.

A claimed launch has no pid and no log, so it SHALL yield no runner usage, and the daemon SHALL NOT ask the runner for it. Its usage SHALL come only from its worker through `POST /v1/launches/:id/usage` (pull-runner "Worker usage"), stored with `source: 'worker'` through the same path, guard, and pricing as runner usage. Because launches with a pid are refused there, the two sources never apply to the same launch. Self-reported usage is not authoritative.

Usage SHALL carry `tokens` as `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` in the same shape for every runner, and `source` naming the reader. `cachedInput` is counted inside `input`, so Claude's cache reads are added to its `input_tokens`, and OpenCode's `cache.read` to its `tokens.input`. The sources are `claude-code`, `codex`, `opencode`, `scripted`, and `worker`.

A usage with any of a cost, turns, a duration, or tokens SHALL be recorded, so a usage with only tokens is recorded. A usage with tokens and no cost SHALL be priced as "Run cost budget" states, per million tokens and rounded to 1e-6:
- billable input `input - cachedInput` at `inputPerMTok`;
- `cachedInput` at `cachedInputPerMTok` (fallback `inputPerMTok`);
- `cacheWriteInput` at `cacheWriteInputPerMTok` (fallback `inputPerMTok`);
- `output` at `outputPerMTok`;
- `reasoningOutput` at `reasoningOutputPerMTok` (fallback `outputPerMTok`).

The pricing rests on two assumptions, both unverified: Codex's `cached_input_tokens` is a subset of `input_tokens`, and `reasoning_output_tokens` is NOT included in `output_tokens`.

Usage found SHALL be stored on the launch row as `costUsd`, `turns`, `durationMs`, `tokens`, `usageSource`, and `costSource` (see "Run cost budget"), and appended as `launch.usage`, whose payload carries the whole usage. `durationMs` SHALL stay unset when the runner reports none; `status.liveLaunches[].elapsedMs` gives wall time.

The cost and tokens of a task SHALL be the sums over its launches, and those of the run the sums over all launches. All of them SHALL be derived from launch rows, so that a restart cannot double count.

A headless agent writes its usage only when it exits. The daemon SHALL therefore record `reportedAt` on the launch when a submit is accepted. It SHALL leave a live launch whose task is `submitted` or `done` running while its process is alive and the report is younger than `health.reportGraceMs` (default 30000; 0 disables the grace). When the process exits or the grace elapses, the daemon SHALL record usage, reap what remains, end the launch with reason `reported`, and remove its worktree.

Token accounting does not change these grace mechanics: in every observed run, Codex wrote `turn.completed` with its usage after its final `agent_message`. Cancelled and superseded launches SHALL be reaped at once as before. A lingering launch delays the idle exit by at most the grace.

#### Scenario: Claude log tail parsed
- **WHEN** a launch log ends with the JSON object `claude -p --output-format json` prints, preceded by stderr lines
- **THEN** the launch row records `costUsd`, `turns`, and `durationMs` from `total_cost_usd`, `num_turns`, and `duration_ms`, and `tokens` from the `usage` object, with `usageSource` `claude-code` and `costSource` `reported`

#### Scenario: Codex log parsed
- **WHEN** a codex launch's log holds `codex exec --json` output with stderr lines between them
- **THEN** the usage read has the summed `turn.completed` tokens, `source` `codex`, and no cost, turns, or duration

#### Scenario: OpenCode log parsed
- **WHEN** an opencode launch's log holds `opencode run --format json` output with stderr lines between them
- **THEN** the usage read has the summed `step_finish` tokens with cache reads inside `input`, the summed `cost` as `costUsd`, `source` `opencode`, and no duration

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

#### Scenario: Claimed launch takes its usage from the worker
- **WHEN** worker `w1` claims T1 and submits, and the runner would have usage for T1
- **THEN** the launch ends with no usage and no `launch.usage`, and a later post by `w1` records it with `usageSource` `worker`
