## MODIFIED Requirements

### Requirement: Health failure reasons
A `running` task SHALL become `failed` with reason `stuck` when stuck detection escalates and with reason `timeBudget` when its launch exceeds the launch time budget. Both SHALL use the orchestrator's `running -> failed` transition, SHALL increase `attempts`, and SHALL follow the retry and exhaustion rules like any other failure, so the next brief carries the reason as the prior failure.

A task whose launch's process ended without a report SHALL fail with reason `exitedWithoutReport`. When the runner can say why, its diagnosis SHALL be recorded as runner-provided detail on that reason, not as a new failure reason or state: the message SHALL be `<base message>: <reason>[: <detail>]` and `detail.runnerFailure` SHALL be `{ reason, detail? }`. The next attempt's brief SHALL carry it in the context from previous attempts, naming the reason and the detail. The Codex runner's reasons are:
- `unknownModel`: an `error` event, an `error` item, or `turn.failed` saying the model does not exist or its metadata was not found; the detail names the model;
- `authFailed`: an error naming a 401, an unauthorized request, or a missing or invalid login;
- `mcpStartupFailed`: a required MCP server that failed to start or initialize, from an error or from stderr; the detail is that line;
- `mcpApprovalRefused`: a failed `mcp_tool_call` item whose error says it was not approved, rejected, denied, or cancelled;
- `sandboxDenied`: the last `command_execution` item failed with `Operation not permitted` (as for `.git` under `workspace-write`), or stderr says so before any turn completed;
- `turnFailed`: any other `turn.failed` or `error`;
- `exitBeforeTurn`: no turn started and nothing above matched; the detail is the last error line on stderr when there is one.

A log whose turn completed with none of these, or a missing log, SHALL give no diagnosis. A runner may give no diagnosis at all; the Claude Code runner gives none.

#### Scenario: Stuck failure spends an attempt and retries with context
- **WHEN** a task on its first attempt is failed with reason `stuck` and `maxAttempts` is 2
- **THEN** `attempts` is one, the task returns to `unstarted`, and its next brief names `stuck` as the prior failure

#### Scenario: Time budget failure exhausts
- **WHEN** a task on its last attempt is failed with reason `timeBudget`
- **THEN** it becomes `blocked` and appears in `stallRoots` with that reason

#### Scenario: Runner diagnosis carried into the retry
- **WHEN** a task on its first attempt with `maxAttempts` 2 has a launch whose process exits without a report and the runner diagnoses `unknownModel` with the error text as detail
- **THEN** the task fails with reason `exitedWithoutReport`, `attempts` is one, and the next brief names `unknownModel` and the detail as the runner's diagnosis of the previous launch

#### Scenario: Codex log classification
- **WHEN** the Codex runner reads a log with only the stderr line ``Error: MCP server `probe` is required but failed to start``
- **THEN** it returns `mcpStartupFailed` with that line as detail

#### Scenario: Complete run gives no diagnosis
- **WHEN** the Codex runner reads a log whose turn completed with no failed MCP call and no denied command
- **THEN** it returns no diagnosis and the failure is recorded as without one

#### Scenario: Runner without a diagnosis
- **WHEN** the launch's runner does not implement `readFailure`
- **THEN** the task fails with reason `exitedWithoutReport` and the message `process exited without a report`, as before
