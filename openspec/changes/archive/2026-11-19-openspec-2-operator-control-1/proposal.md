## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `operator-control`, 24 of the 44 requirements are over the limit. This change, part 1 of 2 of the OpenSpec 2.1 migration of `operator-control` (task ORC-153, under ORC-139), splits 12 of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. The other long requirements are split by `openspec-2-operator-control-2`, which touches disjoint requirements.

## What Changes

- Twelve requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Operator interface | 655 | 192 | 2 | 1 |
  | Status report | 792 | 406 | 5 | 2 |
  | Shutdown | 553 | 302 | 3 | 1 |
  | Run directory | 961 | 331 | 5 | 3 |
  | Daemon lifecycle and discovery | 930 | 392 | 6 | 3 |
  | Review bundle | 3786 | 387 | 7 | 11 |
  | Tracker outbox | 1165 | 410 | 4 | 3 |
  | Status report: health facts | 654 | 427 | 3 | 1 |
  | Reopen with cascade | 614 | 355 | 3 | 1 |
  | Proposals | 1142 | 288 | 5 | 4 |
  | Claims and releases | 753 | 411 | 5 | 2 |
  | Idle exit | 1541 | 189 | 9 | 6 |

- 38 requirements are ADDED, one for each behavior moved out of those descriptions. Each has a name `operator-control` does not have yet, a description of at most 500 characters (the longest is 480), and at least one scenario of its own with a WHEN and a THEN step. Each scenario states behavior the code has at the base commit e0f3aa6; the file (and test) that shows it is named below with the requirement.
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped: the twelve original descriptions hold 78; the cut descriptions hold 28 and the ADDED descriptions 57 (85 in all, the extra ones coming from lead-ins repeated in split sentences and moved list items).

### Splits and lead-ins

The Decisions split a sentence longer than 500 characters at its semicolons. Three original sentences are longer than 500 characters on their own:

- "Review bundle" sentence 3 (the **Index** bullet, 816 characters) is split at its two semicolons into two fragments, each keeping its words: the first holds the bullet's head with `baseline` and `diffStat`, joined by the original semicolon; the second holds the closure entries clause, without its leading "and". Each fragment is given a lead-in that carries the SHALL of the bullet's parent sentence ("`review` SHALL answer in this view:" and "`review` SHALL answer in the index view:").
- "Status report" sentence 1 (538 characters) and the single sentence of "Status report: health facts" (654 characters) have no semicolon: each is one comma list. Each is split at a list-item boundary (before "`claimableByKind`" and before "`budgets`"), every item keeping its words, with the lead-in "`status` SHALL report" or "`status` SHALL additionally report" repeated in the second fragment; the first fragment, which stays in the MODIFIED description, ends where the second begins (the list's final "and" is dropped). This follows the owner's rule for the OpenSpec 2.1 migration tasks (sent as a nudge on 2026-11-18): when semicolons and list items leave a part of a sentence over 500 characters, split it at another clause joint, changing only the words at the joint (here, repeating the subject and verb), so that each part is right when read alone; neither sentence carries an exception that a part would lose. The operator confirmed these splits and the bullet lead-ins for this change (block seq 2, answer A: "Split each comma list at item boundaries with the lead-in repeated in each part, give each moved bullet its list's lead-in before its unchanged text, and list every split and lead-in in the proposal.").

The "Review bundle" bullets "**One task**" and "**Whole bundle**" state no SHALL of their own (it is in the parent sentence "`review` ... SHALL answer in one of three views"). Each moves word for word without its list marker "- ", after the lead-in "`review` SHALL answer in this view:". The sentence "A request is checked in this order: ..." of "Review bundle" has no SHALL either, and OpenSpec 2.1 `--strict` refuses an ADDED requirement without one; it moves word for word, after the lead-in "`review` SHALL answer a request with the first refusal below that applies." (src/operator/review.ts returns at the first refusal).

### Moved sentences

Sentences are numbered from 1 in each original description (a bullet counts as one sentence). *Unchanged* means word for word. *Explicit* means only a reference was made explicit (the replaced words are named). *Split* means cut at its own joints as described above. *Lead-in* means moved word for word after the lead-in named above.

#### Operator interface

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The orchestrator SHALL expose operator routes on its loopback HTTP server, and both a CLI and an MCP server SHALL speak to them."
  - sentence 3, unchanged: "Humans and host sessions SHALL act only through this interface."

- "Operator interface: operations" (scenario from src/operator/mcp-server.ts (TOOL_NAMES); src/operator/cli.ts; test/slice/operator-mcp.test.ts ('drives a run end to end over stdio'); test/slice/operator.test.ts ('every command produces its event and the status report is complete')):
  - sentence 2, unchanged: "The operations SHALL be `status`, `answer`, `cancel` with optional release, `reopen` with optional cascade, `unblock`, `accept`, `reject`, `pause`, `resume` with optional budget override, `logs`, `events`, `review`, `import`, `shutdown`, `start` with optional mode and configuration arguments, `stop`, `runs`, `outbox`, `ack`, `nudge`, `proposals`, `accept_proposal`, `reject_proposal`, `claim`, `release`, `mode`, and `config` to show and set the configuration."

#### Status report

Stays in the MODIFIED description:

  - sentence 1, split: "`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, `blocked`, and `external` sets, `stallRoots`, `awaitingReview`, `verifying`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, any foreign commits, the run directory, the graph file path, the daemon's pid and URL, the latest event sequence number, and `claimableByKind`: the number of claimable launches per runner kind, every kind present, beside the unchanged `claimable` list." → "`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, `blocked`, and `external` sets, `stallRoots`, `awaitingReview`, `verifying`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, any foreign commits, the run directory, the graph file path, the daemon's pid and URL, the latest event sequence number."

- "Status report: claimable launches per kind" (scenario from test/slice/claim.test.ts ('a runner filter skips launches of other kinds, a named task of another kind is 409, and status counts per kind'); src/runner/selection.ts (zeroByKind); src/operator/routes.ts (digest)):
  - sentence 1, split: "`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, `blocked`, and `external` sets, `stallRoots`, `awaitingReview`, `verifying`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, any foreign commits, the run directory, the graph file path, the daemon's pid and URL, the latest event sequence number, and `claimableByKind`: the number of claimable launches per runner kind, every kind present, beside the unchanged `claimable` list." → "`status` SHALL report `claimableByKind`: the number of claimable launches per runner kind, every kind present, beside the unchanged `claimable` list."
  - sentence 3, unchanged: "The event digest SHALL carry `claimableByKind` beside its `claimable` count."

- "Status report: awaiting review and verifying" (scenario from test/loop/scenarios.test.ts ('status lists a submitted task awaiting its check under verifying as well as awaitingReview; a submitted milestone only under awaitingReview')):
  - sentence 2, unchanged: "`awaitingReview` SHALL list every submitted node; `verifying` SHALL list the tasks among them, which await the verifier and not a human, as the event digest's `verifying` does."

#### Shutdown

Stays in the MODIFIED description:

  - sentence 1, unchanged: "Graceful shutdown SHALL stop admission, flush pending transactions, and exit while leaving agent processes running for adoption on the next start."
  - sentence 2, unchanged: "A reaping shutdown SHALL additionally terminate every live agent process."
  - sentence 3, unchanged: "Both SHALL be reachable by signal and by the `shutdown` route with a `reap` flag."

- "Shutdown: caller recorded" (scenario from test/runs/lifecycle.test.ts ('a shutdown through the route records its caller in the event log and the exit record, and the revival refusal names it'); src/runs/runDir.ts (ShutdownCaller, ExitRecord)):
  - sentence 4, unchanged: "The `shutdown` route SHALL record its caller before stopping: the `x-orch-attachment` header when present, the remote address, and the user agent, as `by` in an `operator.shutdown` event carrying `reap`, and the same `by` SHALL reach the exit record."

#### Run directory

Stays in the MODIFIED description:

  - sentence 1, unchanged: "Run data SHALL live outside the repository in `$ORCH_HOME/runs/<id>/`, where `ORCH_HOME` defaults to `~/.orchestrator` and `<id>` is the run id."
  - sentence 2, unchanged: "For a SQLite run the id is the first sixteen hex digits of the SHA-256 of the repository's real path."
  - sentence 3, unchanged: "For a Postgres run it is chosen as specs/state-backend "Run id per deployment" says."

- "Run directory: contents" (scenario from test/runs/lifecycle.test.ts ('start is idempotent, ...', 'runs lists every run with its repository and liveness'); src/runs/runDir.ts (REPO_FILE, DAEMON_JSON, DAEMON_PID, DAEMON_LOG, ensureRunDir, DaemonInfo)):
  - sentence 4, explicit: "The run directory SHALL contain a `repo` file with that path, the store, the graph file, worktrees, logs, verification temp space, `daemon.log`, `daemon.pid`, and `daemon.json` with the daemon's pid, URL, port, start time, repository, and, after a graceful exit, the exit record." → "The run directory SHALL contain a `repo` file with the repository's real path, the store, the graph file, worktrees, logs, verification temp space, `daemon.log`, `daemon.pid`, and `daemon.json` with the daemon's pid, URL, port, start time, repository, and, after a graceful exit, the exit record."

- "Run directory: resolution" (scenario from test/runs/lifecycle.test.ts ('resolves one run from a subdirectory and a symlinked path'); src/runs/runDir.ts (resolveRepoPath)):
  - sentence 5, unchanged: "The CLI and MCP server SHALL resolve the run directory from an explicit repository argument or from the git top level of the working directory, with the same id the daemon chooses."

- "Run directory: runs listing" (scenario from test/runs/lifecycle.test.ts ('runs lists every run with its repository and liveness', 'exits on its own when idle, records why, and is revived with its state intact')):
  - sentence 6, unchanged: "A `runs` operation SHALL list every run with its repository path, whether its daemon is alive, a status digest when it is, and otherwise the exit record or its absence."

#### Daemon lifecycle and discovery

Stays in the MODIFIED description:

  - sentence 1, unchanged: "`start` SHALL be idempotent: if `daemon.pid` names a live process and the recorded URL answers `status`, it SHALL return that URL; otherwise it SHALL spawn the daemon detached with output to `daemon.log`, write `daemon.pid`, wait for the URL to answer within a bounded time, and return it."
  - sentence 2, unchanged: "A stale pid file SHALL be ignored."
  - sentence 3, unchanged: "`stop` SHALL invoke the `shutdown` route and fall back to a signal."

- "Daemon lifecycle: port reuse" (scenario from test/runs/lifecycle.test.ts ('reuses its port across a graceful restart so a mid-task agent stays on the live channel')):
  - sentence 4, unchanged: "The daemon SHALL record its chosen port and SHALL reuse it on the next start when it is free, so that agents launched before a restart reach the daemon after it."

- "Daemon lifecycle: default mode" (scenario from test/runs/lifecycle.test.ts ('adopts --default-mode only when nothing chose a mode, and keeps it across restarts')):
  - sentence 5, unchanged: "The daemon SHALL accept `--default-mode <spawn|pull|mixed>`, which SHALL become the run's durable mode override only when the store holds none and the repository's `orchestrator.yaml` does not set `runner.mode`; `--mode` SHALL keep setting the override unconditionally."

- "Daemon lifecycle: start after an idle exit" (scenario from test/runs/lifecycle.test.ts ('exits on its own when idle, records why, and is revived with its state intact'); src/runs/lifecycle.ts (reviveDaemon)):
  - sentence 6, unchanged: "A daemon started after an idle exit SHALL run recovery as after any stop and SHALL find nothing to adopt."

#### Review bundle

Stays in the MODIFIED description:

  - sentence 1, unchanged: "`review` for a gated milestone in `submitted` SHALL answer in one of three views, named by the answer's field `view`, and every answer SHALL carry `milestone`, the pinned `integrationSha`, `reviewVersion` and the tag name, so that a caller making several calls can see a resubmission between them."
  - sentence 2, unchanged: "In every answer `view` and `omitted` SHALL be serialised before `diffStat` and `closure`."

- "Review bundle: index view" (scenario from test/operator/review.test.ts ('states what the cuts left out', 'keeps an empty stat empty and omits nothing when nothing was cut'); src/operator/review.ts (cutStat, indexOf)):
  - sentence 3, split: "- **Index** (`view: "index"`, the default): `baseline` and the milestone's `acceptanceCriteria` as in the whole bundle; `diffStat`, the first `statLines` file lines of `git diff --stat <baseline>..<integrationSha>` as git printed them, then one line ` ... <k> more files` when k file lines were left out, then git's totals line, which is always kept (an empty stat stays empty); and for every task in the milestone's closure an entry with `taskId`, `title` (the payload's title, else the task id), `status`, `publishedSha`, `summary` cut to `summaryChars` UTF-16 units (one fewer when the cut would split a surrogate pair), `summaryLength` (the whole summary's length), `acceptanceCount` (the evidence items of its report) and `changedFileCount` (the published job's changed files, absent when the job records none)." → "`review` SHALL answer in this view: **Index** (`view: "index"`, the default): `baseline` and the milestone's `acceptanceCriteria` as in the whole bundle; `diffStat`, the first `statLines` file lines of `git diff --stat <baseline>..<integrationSha>` as git printed them, then one line ` ... <k> more files` when k file lines were left out, then git's totals line, which is always kept (an empty stat stays empty)."

- "Review bundle: index entries" (scenario from test/operator/review.test.ts ('states what the cuts left out', 'cuts to zero and never splits a surrogate pair'); src/operator/review.ts (cutSummary, indexOf)):
  - sentence 3, split: "- **Index** (`view: "index"`, the default): `baseline` and the milestone's `acceptanceCriteria` as in the whole bundle; `diffStat`, the first `statLines` file lines of `git diff --stat <baseline>..<integrationSha>` as git printed them, then one line ` ... <k> more files` when k file lines were left out, then git's totals line, which is always kept (an empty stat stays empty); and for every task in the milestone's closure an entry with `taskId`, `title` (the payload's title, else the task id), `status`, `publishedSha`, `summary` cut to `summaryChars` UTF-16 units (one fewer when the cut would split a surrogate pair), `summaryLength` (the whole summary's length), `acceptanceCount` (the evidence items of its report) and `changedFileCount` (the published job's changed files, absent when the job records none)." → "`review` SHALL answer in the index view: for every task in the milestone's closure an entry with `taskId`, `title` (the payload's title, else the task id), `status`, `publishedSha`, `summary` cut to `summaryChars` UTF-16 units (one fewer when the cut would split a surrogate pair), `summaryLength` (the whole summary's length), `acceptanceCount` (the evidence items of its report) and `changedFileCount` (the published job's changed files, absent when the job records none)."

- "Review bundle: index entry omissions" (scenario from test/slice/events.test.ts ('review index cuts follow review.summaryChars; a task cancelled with release has an entry with no report fields'); test/operator/review.test.ts):
  - sentence 4, explicit: "An entry SHALL NOT carry `acceptance`." → "An index entry SHALL NOT carry `acceptance`."
  - sentence 5, unchanged: "A task with no submit report has an empty `summary`, `summaryLength` 0 and `acceptanceCount` 0."

- "Review bundle: omitted list" (scenario from test/operator/review.test.ts ('states what the cuts left out', 'keeps an empty stat empty and omits nothing when nothing was cut')):
  - sentence 6, unchanged: "`omitted` SHALL list `{ field, count, fetch }` for each cut with a count above 0: `closure.acceptance` with the number of tasks that have evidence, `closure.summary` with the number of summaries cut, and `diffStat` with the number of file lines left out."

- "Review bundle: fetch text" (scenario from test/operator/review.test.ts ('states what the cuts left out'); src/operator/review.ts (indexOf)):
  - sentence 7, unchanged: "The `fetch` text of the closure elements SHALL name the tool argument `task`, the HTTP form `GET /v1/milestones/<id>/review?task=<taskId>` and `full=true`; that of `diffStat` SHALL be the command `git diff --stat <baseline>..<integrationSha>` with both shas."

- "Review bundle: one-task view" (scenario from test/slice/events.test.ts ('review bundle for a submitted milestone, error otherwise; status carries run facts'); src/operator/review.ts (taskAnswer)):
  - sentence 8, lead-in: "- **One task** (`view: "task"`, parameter `task=<id>`): `omitted: []`, no `diffStat`, and `closure` with one entry: `taskId`, `title`, `status`, `publishedSha` when there is one, the task's own `acceptanceCriteria`, `changedFiles` when the published job has them, and from the task's latest submit report `summary`, `acceptance`, `interfaces`, `decisions`, `deviations`, `followUps`, `tests` and `noChanges`, but not `proposals`."

- "Review bundle: one task without a report" (scenario from test/slice/events.test.ts ('review index cuts follow review.summaryChars; a task cancelled with release has an entry with no report fields'); src/operator/review.ts (taskAnswer, a synchronous function that runs no git)):
  - sentence 9, unchanged: "A closure task with no submit report SHALL be answered 200 with none of the report's fields."
  - sentence 10, explicit: "This view SHALL make no git call." → "The one-task view SHALL make no git call."

- "Review bundle: whole view" (scenario from test/slice/events.test.ts ('review bundle for a submitted milestone, ...'); test/operator/review.test.ts ('full keeps the bundle and puts view and omitted first')):
  - sentence 11, lead-in: "- **Whole bundle** (`view: "full"`, parameter `full=true`): every key of the bundle the orchestrator builds, with `baseline`, the whole `diffStat` and every closure entry's `summary` and `acceptance`, plus `omitted: []`."

- "Review bundle: cut sizes" (scenario from test/operator/review.test.ts ('config keys default to 40 and 400 and refuse negatives'); test/slice/events.test.ts ('review index cuts follow review.summaryChars; ...'); src/config.ts):
  - sentence 12, unchanged: "The cuts SHALL come from the config keys `review.statLines` (default 40) and `review.summaryChars` (default 400), integers of 0 or more read from the config file at daemon start; the request parameters `statLines` and `summaryChars` SHALL override them for one call, and 0 means none."

- "Review bundle: parameters" (scenario from test/slice/events.test.ts ('review bundle for a submitted milestone, ...'); test/operator/review.test.ts ('reads the parameters as strings'); src/operator/review.ts (parseReviewQuery)):
  - sentence 13, unchanged: "The parameters SHALL be read as follows, and a refusal answered 400 with `{ ok: false, reason, parameter }` naming the parameter: `full` is the whole bundle only for `true`, no for `false` or absent, and refused for any other value; an empty `task`, `statLines` or `summaryChars` is refused; `statLines` and `summaryChars` must be integers of 0 or more, and are checked in every view but have no effect in the one-task and whole views; `task` together with `full=true` is refused."

- "Review bundle: check order" (scenario from test/slice/events.test.ts ('review bundle for a submitted milestone, error otherwise; ...'); src/operator/review.ts (taskAnswer, reviewAnswer)):
  - sentence 14, lead-in: "A request is checked in this order: no graph loaded (409), a refused parameter (400), a node that is not a milestone or a milestone not in `submitted` (409, naming the current status, also when `task` is given), and a `task` that is not a task in the milestone's closure (404 with `{ ok: false, reason, closure }`, the reason naming the id and `closure` listing the closure's task ids)."

#### Tracker outbox

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The daemon SHALL expose `outbox`, returning pending effects with `id` greater than `after` in `id` order, limited in count, together with the tracker policy; `ack`, marking an effect `applied` with the drainer's result; and `nack`, recording the error and either keeping the effect `pending` with `attempts` increased or marking it `failed` at `tracker.maxAttempts`."
  - sentence 2, unchanged: "An unknown effect id SHALL be answered 404."

- "Tracker outbox: effect in ack and nack answers" (scenario from test/slice/outbox.test.ts ('lists, acknowledges, rejects with retry and cap, reports in status and digest, and records the tracker on import')):
  - sentence 3, unchanged: "The answers of `ack` and `nack`, including a repeated `ack` and the 409 for a `nack` of an applied effect, SHALL carry `effect` with only the effect's `id`, `taskId`, `kind`, `status` and `attempts`, plus `result` and `error` when the effect has them, and SHALL NOT carry its `payload`; `outbox` SHALL keep returning each effect with its `payload`."

- "Tracker outbox: CLI and MCP" (scenario from test/slice/operator.test.ts ('outbox and ack commands reach the outbox routes'); test/slice/operator-mcp.test.ts ('records the tracker at import and drives the outbox: list, ack with a result, ack with an error, local argument error')):
  - sentence 4, unchanged: "Both the CLI and the MCP server SHALL expose `outbox` and `ack`, the latter taking a result or an error."

- "Tracker outbox: status facts" (scenario from test/slice/outbox.test.ts ('lists, acknowledges, rejects with retry and cap, reports in status and digest, and records the tracker on import')):
  - sentence 5, unchanged: "`status` SHALL additionally report `tracker` (the recorded kind and workspace, or none), `outboxPending` (the count of pending effects), and `trackerErrors` (every `failed` effect with its id, issue, kind, attempts, and error); the event stream digest SHALL carry `outboxPending` and `trackerErrors`."

#### Status report: health facts

Stays in the MODIFIED description:

  - sentence 1, split: "`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, `overrides`, and `unpricedLaunches` (launches that recorded tokens but no cost, outside `runUsd`), `tokens` with `run` and `byTask` (token counts summed over launch rows in the shape `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }`), `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` and `tokens` when known." → "`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, `overrides`, and `unpricedLaunches` (launches that recorded tokens but no cost, outside `runUsd`), `tokens` with `run` and `byTask` (token counts summed over launch rows in the shape `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }`)."

- "Status report: budgets and live launch facts" (scenario from test/slice/events.test.ts ('review bundle for a submitted milestone, error otherwise; status carries run facts'); test/loop/health.test.ts ('resume records progress and excludes the wait from the launch clock'); src/loop/orchestrator.ts (status)):
  - sentence 1, split: "`status` SHALL additionally report `stuck` (task ids flagged stuck), `pausedReason` (`operator` or `costBudget` while paused), `cost` with `runUsd`, `byTask`, `ceilingUsd`, `overrides`, and `unpricedLaunches` (launches that recorded tokens but no cost, outside `runUsd`), `tokens` with `run` and `byTask` (token counts summed over launch rows in the shape `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }`), `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` and `tokens` when known." → "`status` SHALL additionally report `budgets` with the configured `maxLaunchMs`, `maxRunCostUsd`, `stuckAfterMs`, and `stuckFailAfterMs`, and for every live launch `elapsedMs`, `progressAt`, `lastSignal`, `idleMs`, `stuck`, and `costUsd` and `tokens` when known."

#### Reopen with cascade

Stays in the MODIFIED description:

  - sentence 1, unchanged: "`reopen` SHALL accept an optional `cascade` flag: a `cascade` field in the route body, `--cascade` on the CLI, and a parameter on the MCP tool."
  - sentence 2, unchanged: "Without it, a reopen whose target has started non-milestone dependents reachable through milestones SHALL be refused with 409 and `blockers`."
  - sentence 4, unchanged: "A plain reopen SHALL return `reset` listing the milestones it resets."

- "Reopen with cascade: plan recorded and applied" (scenario from test/slice/operator.test.ts ('reopen --cascade returns the plan and the tick applies it'); test/loop/cascade.test.ts ('is refused while a planned node is publishing, and a dropped job never publishes'); src/operator/routes.ts (reopen route)):
  - sentence 3, explicit: "With it, the daemon SHALL compute the cascade plan, refuse with 409 naming the task when any job in the plan is `publishing`, and otherwise record the `operator.reopen` event with the plan, return `reset: [{ id, from }]`, and apply the plan in the next tick." → "With the `cascade` flag, the daemon SHALL compute the cascade plan, refuse with 409 naming the task when any job in the plan is `publishing`, and otherwise record the `operator.reopen` event with the plan, return `reset: [{ id, from }]`, and apply the plan in the next tick."

#### Proposals

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The operator interface SHALL gain `proposals`, which lists proposals filtered by status with pending as the default, `accept_proposal` with `id`, optional `nodeId`, and optional `payload`, and `reject_proposal` with `id` and a required `note`."
  - sentence 2, unchanged: "Each SHALL be recorded as an operator event."

- "Proposal acceptance: appended node" (scenario from test/slice/proposals.test.ts ('are validated at report time, ...', 'accept without a node id uses the proposal id'); src/operator/routes.ts (acceptProposal)):
  - sentence 3, explicit: "Accepting SHALL append a task node to the run's graph file whose id is `nodeId` when given and the proposal id otherwise, whose `deps` are the proposal's deps plus the proposing task, and whose payload is the proposal's title, description, acceptance criteria, labels, and scope merged with `payload`, plus `proposal` and `proposedBy`." → "Accepting a proposal SHALL append a task node to the run's graph file whose id is `nodeId` when given and the proposal id otherwise, whose `deps` are the proposal's deps plus the proposing task, and whose payload is the proposal's title, description, acceptance criteria, labels, and scope merged with `payload`, plus `proposal` and `proposedBy`."

- "Proposal acceptance: joined milestones" (scenario from test/slice/proposals.test.ts ('are validated at report time, ...', 'accept without a node id uses the proposal id'); src/operator/routes.ts (acceptProposal)):
  - sentence 4, explicit: "When `proposals.joinMilestone` is true (the default) the node SHALL also be added to the `deps` of every gated milestone whose closure contains the proposing task." → "When `proposals.joinMilestone` is true (the default) the accepted proposal's node SHALL also be added to the `deps` of every gated milestone whose closure contains the proposing task."

- "Proposal acceptance: validated write" (scenario from src/operator/routes.ts (acceptProposal: validateGraphContent before writeGraphAndReload, updateProposal only after the write); test/slice/proposals.test.ts ('are validated at report time, ...')):
  - sentence 5, explicit: "The file SHALL be validated and written atomically, reloaded, and the proposal marked `accepted` with the node id; on validation failure nothing SHALL be written and the proposal SHALL stay pending." → "The graph file SHALL be validated and written atomically, reloaded, and the proposal marked `accepted` with the node id; on validation failure nothing SHALL be written and the proposal SHALL stay pending."
  - sentence 6, unchanged: "Accepting a proposal whose node is already in the file SHALL mark it accepted without writing."

- "Proposal rejection" (scenario from test/slice/proposals.test.ts ('are validated at report time, stored pending, listed, accepted into the graph file, joined to the milestone, and rejected with a note')):
  - sentence 7, unchanged: "Rejecting SHALL mark the proposal `rejected` with the note."

#### Claims and releases

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The operator routes SHALL include `POST /v1/claims`, `POST /v1/launches/:id/release`, `POST /v1/launches/:id/usage`, and `PUT /v1/runner` with `{ mode }`, with the semantics given in the pull-runner specification; a claim body MAY carry `attachment` and a release body MAY carry `keep`."
  - sentence 2, unchanged: "Each SHALL be recorded as an event with its arguments before its effect; a usage post SHALL be recorded as `operator.usage`."

- "Claims and releases: CLI and MCP exposure" (scenario from src/operator/mcp-server.ts (TOOL_NAMES); src/operator/cli.ts (release); test/slice/claim.test.ts ('a worker posts usage for its claimed launch after submit, and the priced cost reaches status')):
  - sentence 3, unchanged: "The CLI and the MCP server SHALL expose `claim`, `release` (with `--keep` on the CLI and `keep` on the tool), and the mode override through these routes; the usage route is for worker loops and SHALL be reachable over HTTP."

- "Claims and releases: reaping shutdown" (scenario from test/loop/modes.test.ts ('a mode switch drains parked launches on the next tick, pause holds them, and reap leaves a claimed launch live')):
  - sentence 4, unchanged: "A reaping shutdown SHALL NOT fail claimed launches: the daemon cannot terminate a worker, and the lease governs them."

#### Idle exit

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The configuration SHALL accept `daemon.idleExitMs`, an integer in milliseconds defaulting to 600000 where 0 disables the exit, and `daemon.exitWhileAttached`, a boolean defaulting to false."

- "Idle exit: quiescence" (scenario from test/loop/idle.test.ts ('idle exit: quiescence')):
  - sentence 2, unchanged: "The daemon SHALL be quiescent when the store holds no launch in `preparing`, `launching`, or `live`; no claimable launch whose claim window is finite and has not elapsed (zero in `spawn`, `runner.claimWindowMs` in `mixed`, unbounded in `pull`); no verifier job in `queued`, `checking`, `verified`, or `publishing`; no job in a terminal status not yet applied; and no pending cascade."

- "Idle exit: activity" (scenario from test/loop/idle.test.ts ('resets on a request that is not a probe, holds at zero while a request is in flight', 'never fires when disabled, and a non-quiescent tick is activity'); src/operator/routes.ts (probe routes)):
  - sentence 3, unchanged: "Activity SHALL be the end of any request the API server dispatches other than a probe, a tick at which the daemon was not quiescent, and, unless `exitWhileAttached` is true, a tick at which an attachment was alive."
  - sentence 4, unchanged: "A probe is `GET /v1/status` with `probe=1`, `GET /healthz`, or `GET /readyz` (see specs/cluster-runtime "Probes")."

- "Idle exit: idle time" (scenario from test/loop/idle.test.ts ('resets on a request that is not a probe, ...', 'holds at zero while a live attachment is attached, unless exitWhileAttached')):
  - sentence 5, unchanged: "The daemon SHALL be idle only while quiescent, with no request in flight, and with no live attachment unless `exitWhileAttached` is true; its idle time SHALL be the time since the last activity and zero otherwise."

- "Idle exit: exit when idle" (scenario from test/runs/lifecycle.test.ts ('exits on its own when idle, records why, and is revived with its state intact'); test/loop/idle.test.ts ('never fires when disabled, and a non-quiescent tick is activity')):
  - sentence 6, unchanged: "After every tick, when `idleExitMs` is positive and the idle time reaches it, the daemon SHALL append the event `daemon.idleExit` with `idleMs` and SHALL stop gracefully, keeping agents for adoption, with the exit record reason `idle`."

- "Idle exit: durable work is not activity" (scenario from test/loop/idle.test.ts ('is false with a live launch and with a verifier job, true once everything is applied'); src/loop/orchestrator.ts (quiescent)):
  - sentence 7, unchanged: "Pending tracker effects, an unfinished graph, blocked tasks, and a milestone awaiting review SHALL NOT count as activity."

- "Idle exit: status report" (scenario from test/loop/idle.test.ts ('resets on a request that is not a probe, holds at zero while a request is in flight')):
  - sentence 8, unchanged: "`status` SHALL report `idle: { quiescent, idleMs, exitAfterMs }`."

## Capabilities

### New Capabilities

### Modified Capabilities

- `operator-control`: the 12 requirements above MODIFIED (descriptions cut, scenarios unchanged) and 38 requirements ADDED holding the moved sentences.

## Impact

Only `openspec/changes/openspec-2-operator-control-1/` changes. No code, test or other spec changes. The change is archived after the milestone review.
