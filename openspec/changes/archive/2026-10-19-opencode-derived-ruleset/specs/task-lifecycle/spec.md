## MODIFIED Requirements

### Requirement: Health failure reasons
A `running` task SHALL become `failed` with reason `stuck` when stuck detection escalates and with reason `timeBudget` when its launch exceeds the launch time budget. Both SHALL use the orchestrator's `running -> failed` transition, SHALL increase `attempts`, and SHALL follow the retry and exhaustion rules like any other failure, so the next brief carries the reason as the prior failure.

A task whose launch's process ended without a report SHALL fail with reason `exitedWithoutReport`. When the runner can say why, its diagnosis SHALL be recorded as runner-provided detail on that reason, not as a new failure reason or state: the message SHALL be `<base message>: <reason>[: <detail>]` and `detail.runnerFailure` SHALL be `{ reason, detail? }`. The next attempt's brief SHALL carry it in the context from previous attempts, naming the reason and the detail. The Codex runner's reasons, in the order they are tried, are:
- `mcpStartupFailed`: a required MCP server that failed to start or initialize, from an error or from stderr; the detail is that line;
- `authFailed`: an error naming a 401, an unauthorized request, a missing login (`not logged in`, `codex login`), an invalid or missing API key, an expired token, or an authentication failure, error, or requirement. The bare word `authentication` SHALL NOT match: Codex prints `Using authentication from CODEX_HOME` on a normal run;
- `unknownModel`: an `error` event, an `error` item, or `turn.failed` saying the model does not exist or its metadata was not found; the detail names the model;
- `mcpApprovalRefused`: a failed `mcp_tool_call` item whose error carries Codex's approval wording (`requires approval`, `approval policy`), as in `MCP tool call requires approval, but approval policy is never`; a tool error such as `EACCES: permission denied` SHALL NOT match. The refusal SHALL be diagnosed even when the turn completed afterwards, which is what Codex does;
- `sandboxDenied`: any failed `command_execution` item whose output says `Operation not permitted` (as for `.git` under `workspace-write`), not only the last one; the detail is that command and the line;
- `turnFailed`: any other `turn.failed` or `error`;
- `sandboxDenied`, from the agent: when nothing above matched, an `agent_message` whose text says `Operation not permitted`, because the probes show Codex omitting the denied `git add` and `git commit` from the JSONL and leaving the error only in the agent's message; the detail is that line;
- `sandboxDenied`, from stderr: a stderr line saying `Operation not permitted` before any turn completed;
- `exitBeforeTurn`: no turn started and nothing above matched; the detail is the last stderr line that reads as an error (`error`, `fatal`, or `failed`), and there is no detail otherwise.

The OpenCode runner reads the same kind of log (`opencode run --format json` JSONL and the `--print-logs --log-level WARN` stderr in one file, the last 256 KiB). It strips ANSI colours from stderr lines and drops the `duplicate skill name` warnings OpenCode prints about the user's skill directories. Its reasons, in the order they are tried, are:
- `mcpStartupFailed`: a WARN line `message="server unavailable" key=orchestrator`, even when the turn completed afterwards: the agent worked without the shim, so no report could reach the daemon; the detail is that line;
- `unknownModel`: an ERROR line (or `error` event message) matching `ProviderModelNotFoundError` or `Model not found`; the detail is the line's `error="..."` value, which names the model;
- `authFailed`: an ERROR line (or `error` event message) naming a 401, an unauthorized request, an invalid or missing API key, an expired token, or an authentication failure, error, or requirement; the bare word `authentication` SHALL NOT match. No failed login was observed, so this pattern is carried over from the Codex runner;
- `startupContended`: no JSONL event at all and a stderr line `database is locked`: another opencode held the shared database at startup;
- `permissionDenied`: a `tool_use` part whose `state.error` says `rejected permission`, the detail naming the tool and the command; else a stderr line saying `auto-rejecting`, which is the detail. Only an `ask` gives this, which happens only when an operator overrides the ruleset with one. A `deny` refusal ("The user has specified a rule which prevents you...") goes back to the model and the run goes on, so it SHALL NOT be a diagnosis;
- `turnFailed`: any other `error` event; the detail is the `error="..."` value of the ERROR line that carries the event's `ref` when there is one, else the event's `error.data.message`;
- `exitBeforeTurn`: no JSONL event and nothing above matched; the detail is the last stderr line that reads as an error (`error`, `fatal`, or `failed`), and there is no detail otherwise.

When none of these matched, a log with a `step_finish` part whose `reason` is `stop` SHALL give no diagnosis, as SHALL a log with events but no completed turn.

The probe facts of opencode 1.18.30 behind these (test/fixtures/opencode/events): an unknown model or provider gives only the opaque `error` event `Unexpected server error. Check server logs for details.` with a `ref` and exit 1, and the model is named only on the ERROR line; an MCP server that cannot start gives the WARN line, and the run completes without the tools and exits 0; an auto-rejected `ask` gives the stderr line `permission requested: bash (<command>); auto-rejecting` and a `tool_use` part with `state.status: "error"`. The step then ends with `reason: "tool-calls"`, no further step starts, and the run exits 0, so the model never sees the refusal (F1-ask.jsonl, P-ask.jsonl). A `deny` gives the `tool_use` error, then a further step in which the model goes on (P-deny.jsonl); startup contention gives exit 1, no JSONL, and `Error: Unexpected error` then `database is locked` (4 of 23 concurrent starts, never after the first event).

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

#### Scenario: Approval refusal after which the turn completed
- **WHEN** the Codex runner reads the probe log in which `probe.probe_write` failed with `MCP tool call requires approval, but approval policy is never` and `turn.completed` follows
- **THEN** it returns `mcpApprovalRefused` naming `probe.probe_write`

#### Scenario: Denied command reported only by the agent
- **WHEN** the Codex runner reads the git probe log, whose `command_execution` items all succeeded and whose final `agent_message` quotes `fatal: Unable to create '.../.git/worktrees/.../index.lock': Operation not permitted`
- **THEN** it returns `sandboxDenied` with that line as detail

#### Scenario: Denied command followed by a successful one
- **WHEN** a failed `command_execution` item says `Operation not permitted` and a later `command_execution` item succeeded
- **THEN** it returns `sandboxDenied` naming the denied command

#### Scenario: Ordinary lines are not failures
- **WHEN** a log holds the stderr line `Using authentication from CODEX_HOME` and a failed `mcp_tool_call` whose error is `EACCES: permission denied`, and its turn completed
- **THEN** it returns neither `authFailed` nor `mcpApprovalRefused`

#### Scenario: Complete run gives no diagnosis
- **WHEN** the Codex runner reads a log whose turn completed with no failed MCP call and no denied command
- **THEN** it returns no diagnosis and the failure is recorded as without one

#### Scenario: OpenCode unknown model
- **WHEN** the OpenCode runner reads E-badmodel.jsonl alone
- **THEN** it returns `turnFailed` with `Unexpected server error. Check server logs for details.`; with the ERROR line `ProviderModelNotFoundError: Model not found: opencode/gpt-bogus-9` added it returns `unknownModel` naming `opencode/gpt-bogus-9`

#### Scenario: OpenCode shim unavailable after a completed turn
- **WHEN** the OpenCode runner reads D4.err and D4.jsonl, whose turn completed
- **THEN** it returns `mcpStartupFailed` with the `server unavailable` line

#### Scenario: OpenCode permission rejected
- **WHEN** the OpenCode runner reads F1-ask.jsonl and F1-ask.err
- **THEN** it returns `permissionDenied` with `echo marker-7731` in the detail, and P-ask.jsonl with P-ask.err gives `permissionDenied` naming `uname -s`; F2-deny.jsonl, where the tool was removed and the turn completed, gives no diagnosis

#### Scenario: OpenCode deny refusal continued past
- **WHEN** the OpenCode runner reads P-deny.jsonl or X-chain-offpattern.jsonl, where a bash call got the deny error and the model went on to a `reason: "stop"` step
- **THEN** it gives no diagnosis

#### Scenario: OpenCode startup contention and noise
- **WHEN** the OpenCode runner reads K2.err or SA-proj.err alone
- **THEN** it returns `startupContended`; a log whose only stderr is `duplicate skill name` warnings and whose turn completed gives no diagnosis, and an empty log gives `exitBeforeTurn` without detail

#### Scenario: Uncharged startupContended relaunch observed end to end
- **WHEN** in the real OpenCode run (`ORCH_E2E_OPENCODE=1`) concurrent launches against the shared OpenCode database die at startup with `database is locked`
- **THEN** each such death records `launch.failed` with reason `startupContended` and `charged: false`, the task is relaunched, and its `attempts` equals its launch count minus one minus its uncharged deaths
- **AND** a run in which no start was contended asserts nothing about the rule

#### Scenario: Runner without a diagnosis
- **WHEN** the launch's runner does not implement `readFailure`
- **THEN** the task fails with reason `exitedWithoutReport` and the message `process exited without a report`, as before
