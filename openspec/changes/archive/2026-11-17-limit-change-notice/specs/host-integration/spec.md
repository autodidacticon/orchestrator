## ADDED Requirements

### Requirement: Run skill: workers are told of a limit change
The bullet **a launch needs more time** of each run skill SHALL say that the daemon tells each affected worker of a changed limit through its inbox, as a `nudge` notice the worker sees on its next inbox call, and SHALL NOT tell the session to send a nudge with the new limit. The Codex and OpenCode editions SHALL say that an `orchestrator-work` loop follows the new stuck limit from `status`, unless it was started with `--max-silence-ms`, which keeps that value, and SHALL NOT say that the loop keeps the limit of its claim. The Claude Code edition SHALL keep its sentence on the lease of this session's workers. The Codex and OpenCode bullets SHALL stay identical after the tool-name substitution.

#### Scenario: The session does not send the new limit
- **WHEN** the session raises `budgets.maxLaunchMs` for a launch that needs more time
- **THEN** the skill tells it that the daemon has told the worker through its inbox, and does not tell it to `nudge` the worker

#### Scenario: A loop started with a fixed limit
- **WHEN** the session raises `health.stuckFailAfterMs` for a launch held by an `orchestrator-work` loop
- **THEN** the Codex and OpenCode skills say the loop follows the new limit unless it was started with `--max-silence-ms`

## MODIFIED Requirements

### Requirement: Work loop silence limit
The work loop's silence limit SHALL follow this rule, in this order. `--max-silence-ms` when given SHALL win and SHALL never be replaced; `--max-silence-ms 0` SHALL turn the limit off. Else, when the claim carries no `health` field, the limit SHALL be 45 minutes (the daemon's default `health.stuckFailAfterMs`) and the loop SHALL NOT read `status` for it. Else the first limit SHALL be the claim's `health.stuckFailAfterMs` when positive, and after each `GET /v1/status` answer the limit SHALL be that answer's `budgets.stuckFailAfterMs` when it is a positive number; a value of 0 SHALL give 45 minutes, so a hung agent whose lease the loop renews is still bounded. When `status` cannot be read (an answer that is not 200, a thrown request, or no number there) the loop SHALL keep the limit it had. The loop SHALL log one line when its limit changes.

#### Scenario: The claim names no threshold
- **WHEN** the loop runs without `--max-silence-ms` against a daemon whose claim carries no `health`
- **THEN** the silence limit is 45 minutes, whatever `status` says

#### Scenario: Silence past the limit
- **WHEN** the loop runs with `--max-silence-ms 5000` and the claimed agent writes nothing for longer while its task runs and the launch is still held
- **THEN** the loop ends the agent's process group, releases the launch with `keep: false` and a reason naming the silence, and claims the next launch

#### Scenario: A raise during silence
- **WHEN** the loop runs without `--max-silence-ms`, claims under `health.stuckFailAfterMs: 4000`, and the operator raises it to 60000 through `PUT /v1/config` while the agent is silent
- **THEN** the loop logs the new limit, and does not end the agent when 4000ms of silence have passed

#### Scenario: Status names 0
- **WHEN** the loop runs without `--max-silence-ms` and `status` answers `budgets.stuckFailAfterMs: 0`
- **THEN** the silence limit is 45 minutes, not off

#### Scenario: A fixed limit is not replaced
- **WHEN** the loop runs with `--max-silence-ms 4000` and the operator raises `health.stuckFailAfterMs` to 60000 while the agent is silent
- **THEN** the loop ends the agent after 4000ms of silence

#### Scenario: Status cannot be read
- **WHEN** the loop's `status` read fails or answers without a number at `budgets.stuckFailAfterMs`
- **THEN** the silence limit stays what it was
