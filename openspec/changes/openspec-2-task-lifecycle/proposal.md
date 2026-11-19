## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `task-lifecycle`, 11 of the 16 requirements are over the limit (82 occurrences of SHALL or MUST in their descriptions). This change splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-149).

## What Changes

- Eleven requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters:

  Lengths are measured as OpenSpec 2.1 measures them (non-blank lines trimmed and joined by newlines); the Facts of the brief measure the raw text, which gives 3005, 1249 and 6092 where this table gives 3004, 1248 and 6087.

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Transition table enforcement | 3004 | 209 | 12 | 10 |
  | Counters | 799 | 433 | 5 | 3 |
  | Leases | 679 | 217 | 4 | 2 |
  | Retry and exhaustion | 1248 | 329 | 5 | 3 |
  | Reopen guard | 635 | 253 | 4 | 2 |
  | Milestone review | 594 | 415 | 3 | 1 |
  | Structured blocked reasons | 574 | 319 | 5 | 1 |
  | Health failure reasons | 6087 | 390 | 16 | 19 |
  | Milestone reset | 927 | 352 | 3 | 3 |
  | Cascade reopen | 1164 | 307 | 5 | 4 |
  | Claimable launches | 1220 | 272 | 4 | 4 |

- 52 requirements are ADDED, each holding behavior moved out of one of those descriptions. Each has a name `task-lifecycle` does not have yet, a description of at most 500 characters (the longest is 480), and at least one scenario of its own with a WHEN and a THEN step, based on a test or source file at the base (listed below).
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened: the 11 original descriptions hold 82; the cut descriptions hold 30 and the ADDED descriptions 81 (111). The count rises because a lead-in (of the transition table, of a list, of a split sentence) is repeated in each part, and because moved text with no SHALL or MUST gets one at its joint (see Deviations).
- The five requirements that are not over the limit are not touched, and no file outside this change directory changes. The change is archived after the milestone review.

### Deviations

The owner answered the question at launch block seq 2 with A, with one change, and made it the rule for every migration task: moved text with no SHALL or MUST gets SHALL plus its own verb at the joint and nothing else changes, and facts about an outside tool get a lead-in that binds our code. OpenSpec 2.1 warns on an ADDED requirement whose description has no SHALL or MUST, and that warning fails `--strict`. Applied here:

- The transition table (3004 characters) is split between its rows. The MODIFIED description keeps "The system SHALL permit exactly the transitions ... and MUST reject any other transition ...", its "below" made explicit as the requirements whose names begin with "Transition table:". Each of the ten ADDED "Transition table: ..." requirements repeats the lead-in "The system SHALL permit the transitions below:" (without "exactly", so that each part is right when read alone) and the table's header row, followed by a run of unchanged rows.
- The Codex list lead-in "The Codex runner's reasons, in the order they are tried, are:" becomes "The Codex runner's reasons, in the order they are tried, SHALL be:", repeated before each run of unchanged items; the seven runs are named by their place ("Codex runner reasons, 1 of 7: ..."), so the order stays explicit.
- The OpenCode list lead-in "Its reasons, in the order they are tried, are:" becomes "The OpenCode runner's reasons, in the order they are tried, SHALL be:", repeated the same way over five runs ("OpenCode runner reasons, 1 of 5: ...").
- "The OpenCode runner reads ..." becomes "The OpenCode runner SHALL read ...", and "It strips ... and drops ..." becomes "It SHALL strip ... and drop ...".
- The probe-facts lead-in "The probe facts of opencode 1.18.30 behind these (test/fixtures/opencode/events):" becomes, before each part, "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events):", as the owner asked; the parts are otherwise unchanged.
- "A runner may give no diagnosis at all; the Claude Code runner gives none." travels unchanged beside the SHALL sentence before it.

Splits of single sentences or items:

- "Retry and exhaustion": the `startupContended` sentence (503 characters) is split at its colon. The first part ends with a period and its "those events" is made explicit as "the `launch.failed` events"; the second part starts "On an uncharged `startupContended` death the task SHALL return ...", the subject of the joint repeated.
- "Cascade reopen": the application sentence (547 characters) is split between the items of its list, its lead-in repeated in both parts with "Otherwise" made explicit as "When the cascade is not refused,"; the semicolon that closed the second item becomes a period.
- "Health failure reasons": the OpenCode `permissionDenied` item is 439 characters, over 500 with the list lead-in, so it is split between its sentences: the item text up to its last sentence stays in its run, and its last sentence ("A `deny` refusal ... SHALL NOT be a diagnosis", the closing semicolon a period) moves to **OpenCode deny refusal is not a diagnosis**. The probe-facts sentences are split at their semicolons outside code spans, each joint semicolon a period where it ends a part.

## Capabilities

### New Capabilities

### Modified Capabilities

- `task-lifecycle`: 11 long requirements are split into a cut MODIFIED requirement plus ADDED requirements. The behavior is unchanged.

## Impact

Spec text only; no code changes.

## Moved sentences

Every sentence of each original description is listed (a table row, a list item, or a lead-in counts as one): it stays in the MODIFIED description or moves to exactly one ADDED requirement; a split sentence or a repeated lead-in lists each of its parts. "Unchanged" means word for word; any other change is stated with the new text.

### Transition table enforcement

- "The system SHALL permit exactly the transitions below and MUST reject any other transition with an error naming the current and requested status." stays; reference made explicit: "the transitions below" becomes "the transitions listed in the requirements whose names begin with Transition table:": "The system SHALL permit exactly the transitions listed in the requirements whose names begin with "Transition table:" and MUST reject any other transition with an error naming the current and requested status."
- "| From | To | Whose intent | Trigger |" (the table's header row) is repeated, unchanged, at the head of the table in each ADDED "Transition table: ..." requirement.
- "|---|---|---|---|" (the table's header row) is repeated, unchanged, at the head of the table in each ADDED "Transition table: ..." requirement.
- "| unstarted | blocked | orchestrator | brief validation failed, or a remediation candidate awaits review |" moves to **Transition table: leaving unstarted**, unchanged.
- "| unstarted | blocked | orchestrator | remoteNeedsAgentCommit: on a remote run the task's runner kind has commit policy `daemon`; no launch is created |" moves to **Transition table: leaving unstarted**, unchanged.
- "| unstarted | running | orchestrator | ready, brief valid, slot admitted; launch created |" moves to **Transition table: leaving unstarted**, unchanged.
- "| running | submitted | agent | submit report accepted and sealed |" moves to **Transition table: agent reports on a running task**, unchanged.
- "| running | failed | agent | fail report |" moves to **Transition table: agent reports on a running task**, unchanged.
- "| running | blocked | agent | block delivered through the fallback file after exit |" moves to **Transition table: agent reports on a running task**, unchanged.
- "| running | waiting | agent | block through the long-poll |" moves to **Transition table: agent reports on a running task**, unchanged.
- "| running | failed | orchestrator | process dead without a report, lease expired, or a claimed launch released after progress without keep |" moves to **Transition table: orchestrator fails a running task**, unchanged.
- "| running | failed | orchestrator | worktreeLost: a claimed launch's worktree is gone at startup on a fresh clone; attempts unchanged |" moves to **Transition table: orchestrator fails a running task**, unchanged.
- "| running | unstarted | orchestrator | claimed launch released without progress, or released with keep after progress |" moves to **Transition table: released claimed launch**, unchanged.
- "| running | unstarted | orchestrator | prepareFailed: the prepare command failed in the launch's worktree, below `prepareFailureLimit` failures in a row; attempts and carry unchanged |" moves to **Transition table: prepare failures**, unchanged.
- "| running | blocked | orchestrator | prepareFailed: the prepare command failed `prepareFailureLimit` times in a row; attempts and carry unchanged |" moves to **Transition table: prepare failures**, unchanged.
- "| waiting | running | orchestrator | answer persisted and a slot admitted |" moves to **Transition table: waiting task**, unchanged.
- "| waiting | blocked | orchestrator | maxWait elapsed, process dead, or a claimed launch released |" moves to **Transition table: waiting task**, unchanged.
- "| submitted | done | verifier | published |" moves to **Transition table: verifier outcomes**, unchanged.
- "| submitted | failed | verifier | checks red, undeclared empty diff, missing acceptance evidence, or integration cap hit |" moves to **Transition table: verifier outcomes**, unchanged.
- "| submitted | unstarted | verifier | rebase conflict under the cap |" moves to **Transition table: verifier outcomes**, unchanged.
- "| submitted | blocked | verifier | pushRefused: origin refused the publication push `git.pushRefusalLimit` times; attempts unchanged |" moves to **Transition table: verifier outcomes**, unchanged.
- "| submitted | failed | orchestrator | commitLost: a queued job's sealed commit is missing at startup on a fresh clone; attempts unchanged |" moves to **Transition table: lost commit, retry and exhaustion**, unchanged.
- "| failed | unstarted | orchestrator | attempts below maxAttempts |" moves to **Transition table: lost commit, retry and exhaustion**, unchanged.
- "| failed | blocked | orchestrator | attempts exhausted |" moves to **Transition table: lost commit, retry and exhaustion**, unchanged.
- "| blocked | unstarted | human | unblock or answer |" moves to **Transition table: human transitions**, unchanged.
- "| done or cancelled | unstarted | human | reopen or uncancel when revocable |" moves to **Transition table: human transitions**, unchanged.
- "| running, waiting, submitted, or done | unstarted | human | cascade reopen of an upstream node |" moves to **Transition table: human transitions**, unchanged.
- "| any non-terminal | cancelled | human | cancel |" moves to **Transition table: human transitions**, unchanged.
- "| milestone unstarted | done | orchestrator | closure satisfied, not gated |" moves to **Transition table: milestones**, unchanged.
- "| milestone unstarted | submitted | orchestrator | closure satisfied, gated |" moves to **Transition table: milestones**, unchanged.
- "| milestone submitted | done | human | accept |" moves to **Transition table: milestones**, unchanged.
- "| milestone submitted | blocked | human | reject |" moves to **Transition table: milestones**, unchanged.
- "| milestone done or submitted | unstarted | orchestrator | milestone reset: upstream reopened, or deps changed on reload |" moves to **Transition table: milestones**, unchanged.

### Counters

- "`launches` SHALL increase by one for every spawned process and SHALL never be reset; it names the branch `task/<id>/l<launches>` and the worktree." stays, unchanged.
- "`attempts` SHALL increase by one when a launch ends in `failed` by the agent's fail report, by process death without a report, by lease expiry, or by a verifier red check or cap hit, and SHALL NOT increase on daemon-caused relaunch, on integration conflict, or on a release with `keep`." stays, unchanged.
- "`integrationRetries` SHALL increase by one on each rebase conflict." moves to **Integration retries counter**, unchanged.
- "`interruptions` SHALL increase by one on every release with `keep` that stores an `interrupted` context and SHALL be reset to zero when the task submits." moves to **Interruptions counter**, unchanged.
- "`attempts` and `integrationRetries` SHALL be reset to zero on human unblock, reopen, and uncancel, and on every node reset by a cascade reopen." moves to **Budget resets**, unchanged.

### Leases

- "A `running` or `waiting` task SHALL hold a lease recording `launchId`, `token`, `claimedAt`, `spawnedAt`, `expiresAt`, `baseSha`, and `graphRev`." stays, unchanged.
- "A heartbeat, any API call, and an open long-poll SHALL renew the lease." stays, unchanged.
- "For a launch whose process the daemon can observe, the daemon SHALL also renew the lease on every tick while the runner reports the process alive, including the first tick after adoption, so that the lease TTL bounds silence only for launches the daemon cannot observe." moves to **Lease renewal by observed liveness**, unchanged.
- "The orchestrator SHALL treat an expired lease on a `running` task as failure with reason `leaseExpired`." moves to **Expired lease fails a running task**, unchanged.
- "Silence from a live process SHALL NOT fail the task; it is handled by stuck detection." moves to **Lease renewal by observed liveness**, unchanged.

### Retry and exhaustion

- "When a task becomes `failed` and `attempts` is below `maxAttempts` (default 2), the orchestrator SHALL return it to `unstarted` and the next launch's brief MUST include the prior failure report and any verifier output." stays, unchanged.
- "When `attempts` reaches `maxAttempts`, the orchestrator SHALL move the task to `blocked` with the last reason." stays, unchanged.
- "Every launch that dies without a report SHALL be recorded as a `launch.failed` event carrying the runner's `reason` and `detail` when it gave a diagnosis, and `charged`, whether the death is observed by a tick or by startup recovery." moves to **Launch death record**, unchanged.
- "A death the runner diagnoses as `startupContended` SHALL NOT be charged while the task has had fewer than `health.contendedRetries` (default 3) uncharged contended deaths, counted from those events and never reset: the task SHALL return to `unstarted` at once through the orchestrator's `running -> unstarted` (`released`) transition, with `attempts` unchanged, the transition event carrying `reason: startupContended`, and the next brief carrying the `exitedWithoutReport` failure as the prior failure." is split or repeated:
  - first part, in **Uncharged startupContended deaths** (split at its colon (the sentence is 503 characters); "those events" made explicit as "the `launch.failed` events"): "A death the runner diagnoses as `startupContended` SHALL NOT be charged while the task has had fewer than `health.contendedRetries` (default 3) uncharged contended deaths, counted from the `launch.failed` events and never reset."
  - second part, in **Uncharged contended death returns the task to unstarted** (split at its colon; the subject of the joint is repeated as "On an uncharged `startupContended` death the task"): "On an uncharged `startupContended` death the task SHALL return to `unstarted` at once through the orchestrator's `running -> unstarted` (`released`) transition, with `attempts` unchanged, the transition event carrying `reason: startupContended`, and the next brief carrying the `exitedWithoutReport` failure as the prior failure."
- "The count SHALL be read in the same store transaction that appends the `launch.failed` event." moves to **Uncharged startupContended deaths**, unchanged.
- "Later contended deaths SHALL be charged like any other failure." moves to **Uncharged startupContended deaths**, unchanged.
- "`0` charges every one." moves to **Uncharged startupContended deaths**, unchanged.

### Reopen guard

- "A `done` or `cancelled` node SHALL be revocable only when no non-milestone dependent reachable through any chain of milestones is started, where started means `running`, `waiting`, `submitted`, or `done`." stays, unchanged.
- "Milestone dependents SHALL never block a reopen." stays, unchanged.
- "Reopen and uncancel SHALL reset `attempts` and `integrationRetries`, SHALL NOT reset `launches`, SHALL store a revision context for the next brief when the node has a prior launch, and SHALL reset every `done` or `submitted` milestone downstream of the node." moves to **Reopen and uncancel effects**, unchanged.
- "There SHALL be no flag that skips the guard silently; the escape hatch is `reopen` with `cascade`, which returns its plan." moves to **No silent skip of the reopen guard**; "the guard" made explicit as "the reopen guard": "There SHALL be no flag that skips the reopen guard silently; the escape hatch is `reopen` with `cascade`, which returns its plan."

### Milestone review

- "A human SHALL accept a `submitted` milestone only against its pinned `integrationSha` and `reviewVersion`." stays, unchanged.
- "Rejecting a milestone SHALL move it to `blocked` with reason `milestoneRejected` and the reviewer's note, and the orchestrator SHALL NOT retry it." stays, unchanged.
- "After repair, a human unblock SHALL return it to `unstarted`, and it SHALL be resubmitted as a new review version only when its dependencies are satisfied again." stays, unchanged.
- "An acceptance SHALL NOT survive the reopening of a task in the milestone's closure: the milestone reset discards it and the milestone SHALL be reviewed again at its next version." moves to **Acceptance does not survive a reopen**, unchanged.

### Structured blocked reasons

- "A `blocked` status SHALL carry a reason with a kind from `needsDecision`, `needsAccess`, `impossible`, `dependencyCancelled`, `outOfScope`, `insufficientSpec`, `milestoneRejected`, `pushRefused`, `prepareFailed`, and `remoteNeedsAgentCommit`, plus a message, and for `needsDecision` any options and the eventual answer." stays, unchanged.
- "Only the verifier SHALL set `pushRefused`, and agents MUST NOT block with it." moves to **Blocked kinds reserved to the orchestrator and the verifier**, unchanged.
- "Only the orchestrator SHALL set `prepareFailed`, and agents MUST NOT block with it." moves to **Blocked kinds reserved to the orchestrator and the verifier**, unchanged.
- "Only the orchestrator SHALL set `remoteNeedsAgentCommit`, and agents MUST NOT block with it." moves to **Blocked kinds reserved to the orchestrator and the verifier**, unchanged.

### Health failure reasons

- "A `running` task SHALL become `failed` with reason `stuck` when stuck detection escalates and with reason `timeBudget` when its launch exceeds the launch time budget." stays, unchanged.
- "Both SHALL use the orchestrator's `running -> failed` transition, SHALL increase `attempts`, and SHALL follow the retry and exhaustion rules like any other failure, so the next brief carries the reason as the prior failure." stays, unchanged.
- "A task whose launch's process ended without a report SHALL fail with reason `exitedWithoutReport`." moves to **Runner failure diagnosis**, unchanged.
- "When the runner can say why, its diagnosis SHALL be recorded as runner-provided detail on that reason, not as a new failure reason or state: the message SHALL be `<base message>: <reason>[: <detail>]` and `detail.runnerFailure` SHALL be `{ reason, detail? }`." moves to **Runner failure diagnosis**, unchanged.
- "The next attempt's brief SHALL carry it in the context from previous attempts, naming the reason and the detail." moves to **Runner failure diagnosis**, unchanged.
- "The Codex runner's reasons, in the order they are tried, are:" is split or repeated:
  - lead-in, in **Codex runner reasons, 1 of 7: mcpStartupFailed** (list lead-in repeated before the run, its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The Codex runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **Codex runner reasons, 2 of 7: authFailed** (list lead-in repeated before the run, its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The Codex runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **Codex runner reasons, 3 of 7: unknownModel** (list lead-in repeated before the run, its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The Codex runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **Codex runner reasons, 4 of 7: mcpApprovalRefused** (list lead-in repeated before the run, its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The Codex runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **Codex runner reasons, 5 of 7: sandboxDenied and turnFailed** (list lead-in repeated before the run, its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The Codex runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **Codex runner reasons, 6 of 7: sandboxDenied from the agent and from stderr** (list lead-in repeated before the run, its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The Codex runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **Codex runner reasons, 7 of 7: exitBeforeTurn** (list lead-in repeated before the run, its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The Codex runner's reasons, in the order they are tried, SHALL be:"
- "- `mcpStartupFailed`: a required MCP server that failed to start or initialize, from an error or from stderr; the detail is that line;" moves to **Codex runner reasons, 1 of 7: mcpStartupFailed**, unchanged.
- "- `authFailed`: an error naming a 401, an unauthorized request, a missing login (`not logged in`, `codex login`), an invalid or missing API key, an expired token, or an authentication failure, error, or requirement. The bare word `authentication` SHALL NOT match: Codex prints `Using authentication from CODEX_HOME` on a normal run;" moves to **Codex runner reasons, 2 of 7: authFailed**, unchanged.
- "- `unknownModel`: an `error` event, an `error` item, or `turn.failed` saying the model does not exist or its metadata was not found; the detail names the model;" moves to **Codex runner reasons, 3 of 7: unknownModel**, unchanged.
- "- `mcpApprovalRefused`: a failed `mcp_tool_call` item whose error carries Codex's approval wording (`requires approval`, `approval policy`), as in `MCP tool call requires approval, but approval policy is never`; a tool error such as `EACCES: permission denied` SHALL NOT match. The refusal SHALL be diagnosed even when the turn completed afterwards, which is what Codex does;" moves to **Codex runner reasons, 4 of 7: mcpApprovalRefused**, unchanged.
- "- `sandboxDenied`: any failed `command_execution` item whose output says `Operation not permitted` (as for `.git` under `workspace-write`), not only the last one; the detail is that command and the line;" moves to **Codex runner reasons, 5 of 7: sandboxDenied and turnFailed**, unchanged.
- "- `turnFailed`: any other `turn.failed` or `error`;" moves to **Codex runner reasons, 5 of 7: sandboxDenied and turnFailed**, unchanged.
- "- `sandboxDenied`, from the agent: when nothing above matched, an `agent_message` whose text says `Operation not permitted`, because the probes show Codex omitting the denied `git add` and `git commit` from the JSONL and leaving the error only in the agent's message; the detail is that line;" moves to **Codex runner reasons, 6 of 7: sandboxDenied from the agent and from stderr**, unchanged.
- "- `sandboxDenied`, from stderr: a stderr line saying `Operation not permitted` before any turn completed;" moves to **Codex runner reasons, 6 of 7: sandboxDenied from the agent and from stderr**, unchanged.
- "- `exitBeforeTurn`: no turn started and nothing above matched; the detail is the last stderr line that reads as an error (`error`, `fatal`, or `failed`), and there is no detail otherwise." moves to **Codex runner reasons, 7 of 7: exitBeforeTurn**, unchanged.
- "The OpenCode runner reads the same kind of log (`opencode run --format json` JSONL and the `--print-logs --log-level WARN` stderr in one file, the last 256 KiB)." moves to **OpenCode runner log**; "reads" turned into "SHALL read" (the owner's rule for moved text with no SHALL or MUST), and "the same kind of log" made explicit as "the same kind of log as the Codex runner": "The OpenCode runner SHALL read the same kind of log as the Codex runner (`opencode run --format json` JSONL and the `--print-logs --log-level WARN` stderr in one file, the last 256 KiB)."
- "It strips ANSI colours from stderr lines and drops the `duplicate skill name` warnings OpenCode prints about the user's skill directories." moves to **OpenCode runner log**; "strips ... and drops" turned into "SHALL strip ... and drop" (the owner's rule for moved text with no SHALL or MUST): "It SHALL strip ANSI colours from stderr lines and drop the `duplicate skill name` warnings OpenCode prints about the user's skill directories."
- "Its reasons, in the order they are tried, are:" is split or repeated:
  - lead-in, in **OpenCode runner reasons, 1 of 5: mcpStartupFailed and unknownModel** (list lead-in repeated before the run, "Its" made explicit as "The OpenCode runner's" and its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The OpenCode runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **OpenCode runner reasons, 2 of 5: authFailed** (list lead-in repeated before the run, "Its" made explicit as "The OpenCode runner's" and its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The OpenCode runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **OpenCode runner reasons, 3 of 5: startupContended** (list lead-in repeated before the run, "Its" made explicit as "The OpenCode runner's" and its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The OpenCode runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **OpenCode runner reasons, 4 of 5: permissionDenied** (list lead-in repeated before the run, "Its" made explicit as "The OpenCode runner's" and its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The OpenCode runner's reasons, in the order they are tried, SHALL be:"
  - lead-in, in **OpenCode runner reasons, 5 of 5: turnFailed and exitBeforeTurn** (list lead-in repeated before the run, "Its" made explicit as "The OpenCode runner's" and its verb "are" turned into "SHALL be" (the owner's rule for moved text with no SHALL or MUST)): "The OpenCode runner's reasons, in the order they are tried, SHALL be:"
- "- `mcpStartupFailed`: a WARN line `message="server unavailable" key=orchestrator`, even when the turn completed afterwards: the agent worked without the shim, so no report could reach the daemon; the detail is that line;" moves to **OpenCode runner reasons, 1 of 5: mcpStartupFailed and unknownModel**, unchanged.
- "- `unknownModel`: an ERROR line (or `error` event message) matching `ProviderModelNotFoundError` or `Model not found`; the detail is the line's `error="..."` value, which names the model;" moves to **OpenCode runner reasons, 1 of 5: mcpStartupFailed and unknownModel**, unchanged.
- "- `authFailed`: an ERROR line (or `error` event message) naming a 401, an unauthorized request, an invalid or missing API key, an expired token, or an authentication failure, error, or requirement; the bare word `authentication` SHALL NOT match. No failed login was observed, so this pattern is carried over from the Codex runner;" moves to **OpenCode runner reasons, 2 of 5: authFailed**, unchanged.
- "- `startupContended`: no JSONL event at all and a stderr line `database is locked`: another opencode held the shared database at startup;" moves to **OpenCode runner reasons, 3 of 5: startupContended**, unchanged.
- "- `permissionDenied`: a `tool_use` part whose `state.error` says `rejected permission`, the detail naming the tool and the command; else a stderr line saying `auto-rejecting`, which is the detail. Only an `ask` gives this, which happens only when an operator overrides the ruleset with one. A `deny` refusal ("The user has specified a rule which prevents you...") goes back to the model and the run goes on, so it SHALL NOT be a diagnosis;" is split or repeated:
  - item text up to its last sentence, in **OpenCode runner reasons, 4 of 5: permissionDenied** (the item is 439 characters and with the list lead-in over 500, so it is split between its sentences): "- `permissionDenied`: a `tool_use` part whose `state.error` says `rejected permission`, the detail naming the tool and the command; else a stderr line saying `auto-rejecting`, which is the detail. Only an `ask` gives this, which happens only when an operator overrides the ruleset with one."
  - last sentence of the item, in **OpenCode deny refusal is not a diagnosis** (the item is 439 characters and with the list lead-in over 500, so it is split between its sentences; its closing semicolon becomes a period): "A `deny` refusal ("The user has specified a rule which prevents you...") goes back to the model and the run goes on, so it SHALL NOT be a diagnosis."
- "- `turnFailed`: any other `error` event; the detail is the `error="..."` value of the ERROR line that carries the event's `ref` when there is one, else the event's `error.data.message`;" moves to **OpenCode runner reasons, 5 of 5: turnFailed and exitBeforeTurn**, unchanged.
- "- `exitBeforeTurn`: no JSONL event and nothing above matched; the detail is the last stderr line that reads as an error (`error`, `fatal`, or `failed`), and there is no detail otherwise." moves to **OpenCode runner reasons, 5 of 5: turnFailed and exitBeforeTurn**, unchanged.
- "When none of these matched, a log with a `step_finish` part whose `reason` is `stop` SHALL give no diagnosis, as SHALL a log with events but no completed turn." moves to **No diagnosis from a completed run**; "these" made explicit as "the OpenCode runner's reasons": "When none of the OpenCode runner's reasons matched, a log with a `step_finish` part whose `reason` is `stop` SHALL give no diagnosis, as SHALL a log with events but no completed turn."
- "The probe facts of opencode 1.18.30 behind these (test/fixtures/opencode/events): an unknown model or provider gives only the opaque `error` event `Unexpected server error. Check server logs for details.` with a `ref` and exit 1, and the model is named only on the ERROR line; an MCP server that cannot start gives the WARN line, and the run completes without the tools and exits 0; an auto-rejected `ask` gives the stderr line `permission requested: bash (<command>); auto-rejecting` and a `tool_use` part with `state.status: "error"`." is split or repeated:
  - lead-in with its first two facts, in **OpenCode probe facts: unknown model and unavailable MCP server** (lead-in rewritten as the owner answered (block seq 2) to bind the runner: "The probe facts of opencode 1.18.30 behind these (test/fixtures/opencode/events):" becomes "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events):"; split at its second semicolon, which becomes a period): "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): an unknown model or provider gives only the opaque `error` event `Unexpected server error. Check server logs for details.` with a `ref` and exit 1, and the model is named only on the ERROR line; an MCP server that cannot start gives the WARN line, and the run completes without the tools and exits 0."
  - lead-in with its third fact, in **OpenCode probe facts: auto-rejected ask** (lead-in rewritten as the owner answered (block seq 2) to bind the runner: "The probe facts of opencode 1.18.30 behind these (test/fixtures/opencode/events):" becomes "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events):"; split at its second semicolon): "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): an auto-rejected `ask` gives the stderr line `permission requested: bash (<command>); auto-rejecting` and a `tool_use` part with `state.status: "error"`."
- "The step then ends with `reason: "tool-calls"`, no further step starts, and the run exits 0, so the model never sees the refusal (F1-ask.jsonl, P-ask.jsonl)." moves to **OpenCode probe facts: auto-rejected ask**, unchanged.
- "A `deny` gives the `tool_use` error, then a further step in which the model goes on (P-deny.jsonl); startup contention gives exit 1, no JSONL, and `Error: Unexpected error` then `database is locked` (4 of 23 concurrent starts, never after the first event)." is split or repeated:
  - first clause, in **OpenCode deny refusal is not a diagnosis** (lead-in rewritten as the owner answered (block seq 2) to bind the runner: "The probe facts of opencode 1.18.30 behind these (test/fixtures/opencode/events):" becomes "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events):" before this part; split at its semicolon, which becomes a period): "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): A `deny` gives the `tool_use` error, then a further step in which the model goes on (P-deny.jsonl)."
  - second clause, in **OpenCode probe facts: startup contention** (lead-in rewritten as the owner answered (block seq 2) to bind the runner: "The probe facts of opencode 1.18.30 behind these (test/fixtures/opencode/events):" becomes "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events):" before this part; split at its semicolon): "The OpenCode runner's reasons SHALL rest on these facts of opencode 1.18.30 (test/fixtures/opencode/events): startup contention gives exit 1, no JSONL, and `Error: Unexpected error` then `database is locked` (4 of 23 concurrent starts, never after the first event)."
- "A log whose turn completed with none of these, or a missing log, SHALL give no diagnosis." moves to **No diagnosis from a completed run**; "these" made explicit as "the Codex or OpenCode runner's reasons": "A log whose turn completed with none of the Codex or OpenCode runner's reasons, or a missing log, SHALL give no diagnosis."
- "A runner may give no diagnosis at all; the Claude Code runner gives none." moves to **No diagnosis from a completed run**, unchanged.

### Milestone reset

- "When a task is reopened, uncancelled, or reset by cascade, every milestone reachable downstream from it whose status is `done` or `submitted` SHALL transition to `unstarted` with the event `milestone.reset` carrying the reason `upstreamReopened`, the upstream task, the status it left, and its `reviewVersion`." stays, unchanged.
- "A reload that changes a done or submitted milestone's `deps` SHALL reset it the same way with reason `depsChanged`." moves to **Milestone reset on changed deps**; "the same way" made explicit as "the same way as a milestone reset by a reopened task (see Milestone reset)": "A reload that changes a done or submitted milestone's `deps` SHALL reset it the same way as a milestone reset by a reopened task (see "Milestone reset") with reason `depsChanged`."
- "A reset SHALL retain `reviewVersion` and every existing tag, SHALL clear `accepted` and `integrationSha`, and for a submitted milestone SHALL drop the pending review so that `accept` and `reject` against the old version fail." moves to **Milestone reset effects**; "A reset" made explicit as "A milestone reset": "A milestone reset SHALL retain `reviewVersion` and every existing tag, SHALL clear `accepted` and `integrationSha`, and for a submitted milestone SHALL drop the pending review so that `accept` and `reject` against the old version fail."
- "A `blocked` milestone SHALL NOT be reset." stays, unchanged.
- "When a reset milestone becomes due again it SHALL complete as before: `done` when not gated, and `submitted` with `reviewVersion` incremented and the tag `milestone/<id>/v<reviewVersion>` created at the newly pinned head when gated." moves to **Reset milestone completes again**, unchanged.

### Cascade reopen

- "`reopen` with `cascade` SHALL compute the plan as the target together with every started node reachable downstream through any chain of dependents, tasks and milestones, each with its current status as `from`, and SHALL be refused naming the task when any verifier job of a node in the plan is `publishing`." stays, unchanged.
- "Otherwise the orchestrator SHALL record the plan, return it, and apply it in one tick, dependents before their dependencies, as a sequence of per-node transactions: a `running` or `waiting` node has its process reaped and its launch ended with reason `cascade`; a `submitted` node has its verifier job dropped when the job is `queued`, `checking`, or `verified`, and is deferred to the next tick while its job is `publishing`; a `done` node and the target return to `unstarted`; a done or submitted milestone resets with reason `upstreamReopened`." is split or repeated:
  - items 1 and 2, in **Cascade application: live and submitted nodes** (split between the items of its list (the sentence is 547 characters), its lead-in repeated in each part; "Otherwise" made explicit as "When the cascade is not refused,"; the second item's closing semicolon becomes a period): "When the cascade is not refused, the orchestrator SHALL record the plan, return it, and apply it in one tick, dependents before their dependencies, as a sequence of per-node transactions: a `running` or `waiting` node has its process reaped and its launch ended with reason `cascade`; a `submitted` node has its verifier job dropped when the job is `queued`, `checking`, or `verified`, and is deferred to the next tick while its job is `publishing`."
  - items 3 and 4, in **Cascade application: done nodes and milestones** (split between the items of its list (the sentence is 547 characters), its lead-in repeated in each part; "Otherwise" made explicit as "When the cascade is not refused,"): "When the cascade is not refused, the orchestrator SHALL record the plan, return it, and apply it in one tick, dependents before their dependencies, as a sequence of per-node transactions: a `done` node and the target return to `unstarted`; a done or submitted milestone resets with reason `upstreamReopened`."
- "Every reset task SHALL have `attempts` and `integrationRetries` set to zero, `launches` retained, and a revision context stored with cause `upstreamReopened` and the target as `upstream`, or cause `reopened` for the target itself." moves to **Cascade budgets and revision context**; "Every reset task" made explicit as "Every task reset by a cascade reopen" and "the target as" as "the target of the cascade as": "Every task reset by a cascade reopen SHALL have `attempts` and `integrationRetries` set to zero, `launches` retained, and a revision context stored with cause `upstreamReopened` and the target of the cascade as `upstream`, or cause `reopened` for the target itself."
- "After a cascade is applied no started task SHALL depend on an unstarted node." moves to **No started task on an unstarted node after a cascade**, unchanged.

### Claimable launches

- "In `pull` and `mixed` modes a launch SHALL be parked as `claimable` once its worktree and brief exist." stays, unchanged.
- "The task SHALL be `running` from the moment the launch row exists and SHALL hold a run slot while parked, so that the number of parked launches is bounded by `capacity`." stays, unchanged.
- "The lease of a parked launch SHALL NOT expire; its TTL SHALL start at the claim, when `claimedAt` and `expiresAt` are set and `spawnedAt` stays unset." moves to **Parked launch lease**, unchanged.
- "A claimed launch's lease SHALL be renewed by any API call under its token, by observed worktree progress, at admission when the task resumes from `waiting`, and by its work loop's renewal (see specs/pull-runner "Lease renewal by the work loop"), which is not progress." moves to **Claimed launch lease renewal**, unchanged.
- "An expired lease on a claimed launch whose worktree shows progress since the claim SHALL be a kept release while the task's kept releases are under `daemon.maxKeptReleases`: `unstarted` with `attempts` unchanged and the branch kept (see specs/pull-runner "Lease expiry")." moves to **Expired lease on a claimed launch**, unchanged.
- "Otherwise it SHALL follow the existing failure path: `failed` with reason `leaseExpired`, `attempts` increased, the worktree swept, and a new launch prepared while attempts remain." moves to **Expired lease on a claimed launch**, unchanged.
- "`launches` SHALL increase by one for every launch row, claimed or spawned." moves to **Launch count for claimed and spawned launches**, unchanged.

## Sources of the new scenarios (at base c37d8c4)

- **Transition table: leaving unstarted**: `src/state/transitions.ts` (`TRANSITIONS`), `test/state/transitions.test.ts` ("counter effects per row", "every non-row is rejected").
- **Transition table: agent reports on a running task**: `test/state/transitions.test.ts` ("counter effects per row", "leaving running clears the lease unless patched").
- **Transition table: orchestrator fails a running task**: `test/loop/health.test.ts` ("a silent but alive agent keeps its lease past the TTL; unknown liveness still expires it").
- **Transition table: released claimed launch**: `test/state/transitions.test.ts` ("a claimed launch released without progress returns to unstarted at no cost").
- **Transition table: prepare failures**: `test/state/transitions.test.ts` ("a failed prepare command returns the task to unstarted at no cost, by the orchestrator only (ORC-130)").
- **Transition table: waiting task**: `test/loop/scenarios.test.ts` ("maxWait degrades to blocked with the question kept; a later answer makes a new launch").
- **Transition table: verifier outcomes**: `test/state/transitions.test.ts` ("counter effects per row").
- **Transition table: lost commit, retry and exhaustion**: `test/state/transitions.test.ts` ("counter effects per row").
- **Transition table: human transitions**: `test/state/transitions.test.ts` ("every row is allowed for its node kinds and actor", "counter effects per row").
- **Transition table: milestones**: `test/state/transitions.test.ts` ("counter effects per row", "cascade rows reset budgets for every started task status; milestone reset is the orchestrator's alone").
- **Integration retries counter**: `test/state/transitions.test.ts` ("counter effects per row").
- **Interruptions counter**: `test/loop/scenarios.test.ts` ("is bounded by daemon.maxKeptReleases and the counter resets on submit").
- **Budget resets**: `src/state/transitions.ts` (the `uncancel` row's `resetBudgets` effect), `test/state/transitions.test.ts` ("counter effects per row").
- **Lease renewal by observed liveness**: `test/loop/health.test.ts` ("a silent but alive agent keeps its lease past the TTL; unknown liveness still expires it").
- **Expired lease fails a running task**: `test/loop/health.test.ts` (the same test, its second half).
- **Launch death record**: `test/health/contended.test.ts` ("any other death is charged and still recorded as launch.failed").
- **Uncharged startupContended deaths**: `test/health/contended.test.ts` ("health.contendedRetries bounds the allowance; 0 charges every contended death").
- **Uncharged contended death returns the task to unstarted**: `test/health/contended.test.ts` ("a startupContended death is recorded uncharged and the task returns to unstarted with attempts unchanged").
- **Reopen and uncancel effects**: `test/loop/scenarios.test.ts` ("reopening a task under an accepted milestone resets the milestone, which resubmits at version 2 with a new tag").
- **No silent skip of the reopen guard**: `test/loop/cascade.test.ts` ("plain reopen is refused with blockers; cascade returns the plan and applies it in one tick with budgets reset and revision context").
- **Acceptance does not survive a reopen**: `test/loop/scenarios.test.ts` ("reopening a task under an accepted milestone resets the milestone, which resubmits at version 2 with a new tag").
- **Blocked kinds reserved to the orchestrator and the verifier**: `src/loop/orchestrator.ts` (`questionSchema`, whose `kind` enum leaves out `pushRefused`, `prepareFailed` and `remoteNeedsAgentCommit`, and the `block` handler answering 400 `malformed`).
- **Milestone reset on changed deps**: `test/loop/scenarios.test.ts` ("a submitted milestone resets when its deps change on reload; an automatic milestone resets and completes again").
- **Milestone reset effects**: `test/loop/scenarios.test.ts` ("reopening a task under an accepted milestone resets the milestone, which resubmits at version 2 with a new tag").
- **Reset milestone completes again**: `test/loop/scenarios.test.ts` (the same test: tags v1 and v2).
- **Cascade application: live and submitted nodes**: `test/loop/cascade.test.ts` ("plain reopen is refused with blockers; ...").
- **Cascade application: done nodes and milestones**: `src/loop/tick.ts` (`applyPendingCascade`).
- **Cascade budgets and revision context**: `test/loop/cascade.test.ts` ("plain reopen is refused with blockers; ...").
- **No started task on an unstarted node after a cascade**: `test/loop/cascade.test.ts` ("a crash mid-cascade resets only what is still started").
- **Parked launch lease**: `test/loop/modes.test.ts` ("pull parks launches and never spawns; a parked launch outlives the lease TTL and holds a capacity slot"), `test/loop/lease.test.ts` ("the claim states the lease TTL, the expiry, and the interval; ...").
- **Claimed launch lease renewal**: `test/loop/lease.test.ts` ("a loop renewal keeps a silent claimed launch past the TTL and is not progress: it is still reported stuck").
- **Expired lease on a claimed launch**: `test/loop/lease.test.ts` ("an expiry with a commit since the claim is a kept release: ...", "an expiry without progress in the worktree spends the attempt, even after calls").
- **Launch count for claimed and spawned launches**: `test/loop/lease.test.ts` ("an expiry without progress in the worktree spends the attempt, even after calls").
- **Runner failure diagnosis**: `test/loop/health.test.ts` ("a dead launch fails exitedWithoutReport with the runner's reason and detail, and the next brief carries it").
- **Codex runner reasons, 1 of 7: mcpStartupFailed**: `test/runner/codex.test.ts` ("names a required MCP server that failed to start, with the ERROR stderr line (empty stdout plus D-stderr.txt)").
- **Codex runner reasons, 2 of 7: authFailed**: `test/runner/codex.test.ts` ("names a missing login as authFailed", "does not read the CODEX_HOME authentication line or an EACCES tool error as a failure").
- **Codex runner reasons, 3 of 7: unknownModel**: `test/runner/codex.test.ts` ("names the brief's 'Model metadata ... not found' error item as unknownModel").
- **Codex runner reasons, 4 of 7: mcpApprovalRefused**: `test/runner/codex.test.ts` ("does not read the CODEX_HOME authentication line or an EACCES tool error as a failure", "names an MCP tool call refused for approval although the turn completed afterwards (E-events.jsonl)").
- **Codex runner reasons, 5 of 7: sandboxDenied and turnFailed**: `test/runner/codex.test.ts` ("names a sandbox denial from a failed command_execution even when a later command succeeded").
- **Codex runner reasons, 6 of 7: sandboxDenied from the agent and from stderr**: `test/runner/codex.test.ts` ("names a sandbox denial that only the agent message reports (both real git probes)").
- **Codex runner reasons, 7 of 7: exitBeforeTurn**: `test/runner/codex.test.ts` ("names an exit before any turn, with the last error line on stderr and no detail otherwise").
- **OpenCode runner log**: `test/runner/opencode.test.ts` ("duplicate skill warnings are noise; an empty log is exitBeforeTurn without detail").
- **OpenCode runner reasons, 1 of 5: mcpStartupFailed and unknownModel**: `test/runner/opencode.test.ts` ("a shim that never started is mcpStartupFailed although the turn completed", "an unknown model alone is an opaque turnFailed; with its ERROR line it is unknownModel naming the model").
- **OpenCode runner reasons, 2 of 5: authFailed**: `test/runner/opencode.test.ts` ("an ERROR line about the login is authFailed; the bare word authentication is not").
- **OpenCode runner reasons, 3 of 5: startupContended**: `test/runner/opencode.test.ts` ("a locked shared database at startup is startupContended").
- **OpenCode runner reasons, 4 of 5: permissionDenied**: `test/runner/opencode.test.ts` ("a rejected command is permissionDenied naming it; a removed tool with a completed turn is not a failure").
- **OpenCode runner reasons, 5 of 5: turnFailed and exitBeforeTurn**: `test/runner/opencode.test.ts` ("turnFailed takes the ERROR line carrying the event ref", "duplicate skill warnings are noise; an empty log is exitBeforeTurn without detail").
- **OpenCode probe facts: unknown model and unavailable MCP server**: `test/runner/opencode.test.ts` ("an unknown model alone is an opaque turnFailed; ...", "a shim that never started is mcpStartupFailed although the turn completed").
- **OpenCode probe facts: auto-rejected ask**: `test/runner/opencode.test.ts` ("an auto-rejected ask ends the run and is permissionDenied naming the command").
- **OpenCode deny refusal is not a diagnosis**: `test/runner/opencode.test.ts` ("a deny refusal the agent continued past is not a failure").
- **OpenCode probe facts: startup contention**: `test/runner/opencode.test.ts` ("a locked shared database at startup is startupContended").
- **No diagnosis from a completed run**: `test/runner/codex.test.ts` ("returns undefined for a complete run with turn.completed, and for a missing log", "the MultiRunner routes readFailure by kind; a runner without it gives undefined"), `test/runner/opencode.test.ts` ("OpenCodeRunner.readFailure classifies the launch log; no log is no diagnosis").
