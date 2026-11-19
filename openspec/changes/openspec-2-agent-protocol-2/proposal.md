## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `agent-protocol`, 16 of the 33 requirements are over the limit. This change, part 2 of 2 of the OpenSpec 2.1 migration of `agent-protocol` (task ORC-170, under ORC-139), splits 10 of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. The other six are split by `openspec-2-agent-protocol-1`, which touches disjoint requirements.

## What Changes

- Ten requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Brief validation and remediation | 681 | 448 | 2 | 2 |
  | Inbox notices for health | 751 | 404 | 3 | 1 |
  | Revision context in the brief | 655 | 336 | 2 | 2 |
  | Proposals in the report | 617 | 406 | 2 | 1 |
  | Worker access | 1093 | 283 | 4 | 3 |
  | Interrupted context in the brief | 879 | 216 | 3 | 2 |
  | Check command and tool rules in the brief | 2047 | 335 | 6 | 7 |
  | Agent environment | 2079 | 379 | 4 | 8 |
  | Inbox notices handed out once | 725 | 327 | 4 | 1 |
  | Limit change notice | 1353 | 353 | 6 | 6 |

- 33 requirements are ADDED, one for each behavior moved out of those descriptions. Each is named after the MODIFIED requirement its text comes from, then a colon and the behavior it holds, a name `agent-protocol` does not have yet. Each has a description of at most 500 characters (the longest is 471) that holds SHALL or MUST, and one scenario of its own with a WHEN and a THEN step. Each scenario states behavior the code has at the base commit 941ee02; the file (and test) that shows it is named below with the requirement.
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened: the ten original descriptions hold 74; the cut descriptions hold 21 and the ADDED descriptions 55 (76 in all). The two extra ones come from the "Agent environment" list lead-in, which is repeated in two ADDED requirements (see Splits and lead-ins).
- No other requirement of `agent-protocol` changes, and no file outside this change directory changes.

### Splits and lead-ins

No sentence of the ten originals is longer than 500 characters on its own, so no sentence is split at its semicolons or at another clause joint. One list is split between its items, and one list item between its two sentences:

- "Agent environment" opens with the list lead-in "A launch the daemon spawns SHALL inherit the daemon's environment with these changes:" followed by four items. The MODIFIED description keeps the lead-in and the first, second and fourth items, unchanged. The third item holds two sentences (the withholding sentence, 351 characters, and the sentence on what passes without withholding), which with the lead-in come to more than 500 characters. It is split between those two sentences:
  - **Agent environment: withheld store variables** holds the lead-in, repeated unchanged, and the item's first sentence, unchanged with its "- " list marker.
  - **Agent environment: store variables passed without withholding** holds the lead-in, repeated unchanged, and the item's second sentence as its own list item. That sentence has no SHALL of its own, so it takes its list's lead-in. Its references are made explicit: "it" becomes "the daemon", and "they" becomes the variables the first sentence names. Because it now opens its own list item, it gains the "- " marker and its first word "While" is lowercased. Its closing ";" becomes ".", since the item ends the description.
- No other lead-in is added, and no verb is turned into SHALL at a joint. Every other moved sentence carries its own SHALL or MUST.

One ADDED requirement holds two sentences that are not adjacent in the original: **Agent environment: no run of the user's** holds the client sentence ("An orchestrator client the agent runs therefore SHALL ...") and the specs/state-backend pointer ("What a spawned agent ... is stated in ..."), between which the original has the `ORCH_API` sentence, which moves to **Agent environment: ORCH_API kept**.

### Moved sentences

Sentences are numbered from 1 in each original description; a list item counts as one sentence, except the third item of "Agent environment", whose two sentences are sentences 4 and 5. *Unchanged* means word for word. *Explicit* means only a reference was made explicit (the replaced words are named) or, where stated, a change listed under Splits and lead-ins. Every sentence either stays in its MODIFIED description or moves to exactly one ADDED requirement; the list lead-in of "Agent environment" stays and is also repeated in two.

#### Brief validation and remediation

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The brief template SHALL declare slots with a source, a `required` flag, and a minimum length, and the orchestrator SHALL validate a task against them when it becomes ready, or at ingest in strict mode."
  - sentence 2, unchanged: "When validation fails, the configured policy SHALL either block the task with reason `insufficientSpec` listing the missing slots, or invoke the remediation hook to produce the missing content stored as a payload overlay keyed by graph revision."

- **Brief validation and remediation: review and auto modes** (scenario from test/loop/brief.test.ts ("auto mode launches directly with the candidate applied"); src/loop/tick.ts (the `remediateMode === 'auto'` branch)):
  - sentence 3, explicit ("the candidate" made explicit as "the remediation hook's candidate"): "In `review` mode (default) the candidate SHALL land as `blocked` with kind `needsDecision` for a human to accept, edit, or reject; in `auto` mode it SHALL launch directly." → "In `review` mode (default) the remediation hook's candidate SHALL land as `blocked` with kind `needsDecision` for a human to accept, edit, or reject; in `auto` mode it SHALL launch directly."
- **Brief validation and remediation: default hook** (scenario from src/brief/remediate.ts (`noRemediation` returns undefined); src/loop/orchestrator.ts (`deps.remediator ?? noRemediation`); src/loop/tick.ts (no candidate falls through to `insufficientSpec`)):
  - sentence 4, explicit ("the hook interface" made explicit as "the remediation hook interface"): "v1 SHALL ship the hook interface with a default that blocks." → "v1 SHALL ship the remediation hook interface with a default that blocks."

#### Inbox notices for health

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The inbox SHALL deliver notices of kind `stuck` with `idleMs` and a `message`, `nudge` with the operator's `message`, `baseMoved` with the new integration `head` and the `files` its commit touched, and `payloadChanged` with the new graph `rev`."
  - sentence 2, unchanged: "The brief's workspace section SHALL state that such notices may arrive in the inbox, name the four kinds, and tell the agent to check `inbox` after long steps."

- **Inbox notices for health: integration branch rules** (scenario from test/loop/brief-health.test.ts ("keeps the rebase allowance under the agent commit policy and drops it under daemon")):
  - sentence 3, unchanged: "The brief SHALL state that merging into, pushing to, or checking out the integration branch is not allowed."
  - sentence 4, explicit ("it" made explicit as "the brief"): "Under the `agent` commit policy it SHALL state that rebasing the launch branch onto the integration head is allowed." → "Under the `agent` commit policy the brief SHALL state that rebasing the launch branch onto the integration head is allowed."
  - sentence 5, explicit ("it" made explicit as "the brief"): "Under `daemon` it SHALL instead state that the orchestrator rebases the branch onto the integration head at verification." → "Under `daemon` the brief SHALL instead state that the orchestrator rebases the branch onto the integration head at verification."

#### Revision context in the brief

Stays in the MODIFIED description:

  - sentence 1, unchanged: "When a task is relaunched after reopen, uncancel, or a cascade reset, its brief SHALL carry a `revision` context with `cause` of `reopened` or `upstreamReopened`, `upstream` naming the reopened task when the cause is `upstreamReopened`, `priorLaunchId`, `priorBranch`, and, when they exist, `priorPublishedSha` and `priorReportSummary`."

- **Revision context in the brief: revise the prior work** (scenario from test/loop/brief.test.ts ("names the published prior commit, the upstream cause, and tells the agent to revise")):
  - sentence 2, explicit ("The brief" made explicit as "The brief that carries a `revision` context"): "The brief SHALL state that the prior published commit remains on the integration branch and is contained in `baseSha`, and SHALL instruct the agent to revise the prior work rather than redo it." → "The brief that carries a `revision` context SHALL state that the prior published commit remains on the integration branch and is contained in `baseSha`, and SHALL instruct the agent to revise the prior work rather than redo it."
- **Revision context in the brief: stored with the attempt context** (scenario from test/loop/cascade.test.ts ("plain reopen is refused with blockers; cascade returns the plan and applies it in one tick with budgets reset and revision context"); src/loop/tick.ts (the cascade reset stores `carry: { revision }`); src/launch/launch.ts (`carry: undefined` when the spawned launch goes live)):
  - sentence 3, explicit ("The context" made explicit as "The `revision` context"): "The context SHALL be stored on the overlay entry at reset and cleared when the launch goes live, like other attempt context." → "The `revision` context SHALL be stored on the overlay entry at reset and cleared when the launch goes live, like other attempt context."

#### Proposals in the report

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The submit report MAY carry `proposals`, a list of `{ title, description, acceptanceCriteria, deps?, scope?, labels? }` where `title`, `description`, and at least one acceptance criterion are required and every id in `deps` MUST name a node in the launch's graph revision."
  - sentence 2, unchanged: "A report that violates this SHALL be answered 400 as malformed and the task SHALL stay `running`."
  - sentence 3, unchanged: "`followUps` SHALL remain free text."

- **Proposals in the report: stored pending** (scenario from test/slice/proposals.test.ts ("are validated at report time, stored pending, listed, accepted into the graph file, joined to the milestone, and rejected with a note")):
  - sentence 4, explicit ("the report" made explicit as "the submit report"): "When the report is accepted each proposal SHALL be stored as pending with id `<taskId>-p<n>`, where `n` counts the task's proposals from one, and the orchestrator SHALL NOT add any node to the graph on its own." → "When the submit report is accepted each proposal SHALL be stored as pending with id `<taskId>-p<n>`, where `n` counts the task's proposals from one, and the orchestrator SHALL NOT add any node to the graph on its own."

#### Worker access

Stays in the MODIFIED description:

  - sentence 1, unchanged: "A worker that holds a claimed launch SHALL use the same five operations with the launch token, either directly against the loopback API or through the token-scoped operator tools, and SHALL be subject to the same scoping, deduplication, sealing, and fencing rules as a spawned agent."

- **Worker access: no façade spawned for a claimed launch** (scenario from test/slice/launch.test.ts ("pull mode parks the launch as claimable with its brief; a claim makes it live with a worker and no pid")):
  - sentence 2, unchanged: "The daemon SHALL NOT spawn the per-launch MCP façade for a claimed launch."
  - sentence 3, unchanged: "A worker loop that runs the agent as its own process, such as the Codex work loop, MAY register the façade for that process the way the runner of that kind registers it for a spawned launch, with the launch's identity in the same env file, so that the agent sees the same tool names."
- **Worker access: no fallback file for workers** (scenario from test/slice/claim-recovery.test.ts ("a restart keeps a claimed launch live and its worker keeps working; an abandoned claim expires into a failed attempt"); src/loop/tick.ts and src/launch/recovery.ts (the only callers of `readFallback`, on a launch whose process is found dead)):
  - sentence 4, unchanged: "The fallback file SHALL NOT be available to workers: the orchestrator reads `.orchestrator/report.json` only when it finds a launch's process dead, and a claimed launch has no process the daemon watches, so a worker that cannot reach the API SHALL keep retrying until the daemon answers or its lease expires."
- **Worker access: one brief for spawned and claimed launches** (scenario from test/slice/codex-work.test.ts ("the preamble names the launch, the 401 rule, and the fallback-file rule")):
  - sentence 5, explicit ("its" made explicit as "the brief's"): "The brief SHALL be the same document for spawned and claimed launches, and the worker instructions SHALL override its fallback-file guidance." → "The brief SHALL be the same document for spawned and claimed launches, and the worker instructions SHALL override the brief's fallback-file guidance."

#### Interrupted context in the brief

Stays in the MODIFIED description:

  - sentence 1, unchanged: "When a task is relaunched after a release with `keep`, its brief SHALL carry an `interrupted` context with `priorLaunchId`, `priorBranch`, `headSha`, `reason`, and `wipCommit` when uncommitted changes were preserved."

- **Interrupted context in the brief: continue from the kept branch** (scenario from test/loop/brief.test.ts ("names the branch, head, and WIP commit and tells the agent to continue or start over")):
  - sentence 2, explicit ("The brief" made explicit as "A brief carrying an `interrupted` context", "that reason" as "its `reason`", "that head" as "`headSha`"): "The brief SHALL state that the previous launch was interrupted for that reason, that the branch holds its work so far at that head and that the work-in-progress commit, when present, holds changes the previous worker had not committed, and SHALL instruct the agent to continue from that branch by merging or cherry-picking it onto the new base, or to inspect it and start over, and to squash the work-in-progress commit before submitting." → "A brief carrying an `interrupted` context SHALL state that the previous launch was interrupted for its `reason`, that the branch holds its work so far at `headSha` and that the work-in-progress commit, when present, holds changes the previous worker had not committed, and SHALL instruct the agent to continue from that branch by merging or cherry-picking it onto the new base, or to inspect it and start over, and to squash the work-in-progress commit before submitting."
- **Interrupted context in the brief: stored with the attempt context** (scenario from test/loop/scenarios.test.ts ("after progress leaves attempts unchanged, stores the interrupted context, and the next brief carries it until the launch goes live")):
  - sentence 3, explicit ("The context" made explicit as "The `interrupted` context"): "The context SHALL be stored on the overlay entry at the release and cleared when the next launch goes live, like other attempt context, and SHALL coexist with a question and answer when the release happened while `waiting`." → "The `interrupted` context SHALL be stored on the overlay entry at the release and cleared when the next launch goes live, like other attempt context, and SHALL coexist with a question and answer when the release happened while `waiting`."

#### Check command and tool rules in the brief

Stays in the MODIFIED description:

  - sentence 1, unchanged: "The brief's definition of done SHALL name the effective check command at the time the brief is composed."
  - sentence 2, unchanged: "When `checkCommand` is unresolved the brief SHALL say that no check command is configured for the repository yet, that the operator is being asked, and that the agent must run the project's documented test suite before submitting."

- **Check command and tool rules in the brief: Claude Code Bash rules** (scenario from test/loop/brief.test.ts ("names the detected command and lists the Bash rules in force for a spawned launch"); src/brief/compose.ts (line 211)):
  - sentence 3, unchanged: "For spawned launches whose runner carries an allow list (the Claude Code runner), the brief's workspace section SHALL list the Bash rules in force, stating that a worker holding a claimed launch runs under its own permissions instead."
- **Check command and tool rules in the brief: Claude Code command guidance** (scenario from test/loop/brief.test.ts ("names the detected command and lists the Bash rules in force for a spawned launch")):
  - sentence 4, explicit ("It" made explicit as "The brief's workspace section for a spawned launch whose runner carries an allow list"): "It SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own." → "The brief's workspace section for a spawned launch whose runner carries an allow list SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own."
  - sentence 5, explicit ("It" made explicit as "The brief's workspace section for a spawned launch whose runner carries an allow list"): "It SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it." → "The brief's workspace section for a spawned launch whose runner carries an allow list SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it."
- **Check command and tool rules in the brief: Codex sandbox** (scenario from test/loop/brief.test.ts ("a codex launch under agent commits keeps the git-write sentences and names its sandbox", "a codex launch under daemon commits gets the sandbox paragraph and read-only git text")):
  - sentence 6, unchanged: "For a `codex` launch the workspace section SHALL carry no Bash rules."
  - sentence 7, explicit ("It" made explicit as "The workspace section of a `codex` launch"): "It SHALL instead name the Codex sandbox mode and say that approvals are disabled, so a command the sandbox refuses fails with `Operation not permitted` and is not approved at runtime." → "The workspace section of a `codex` launch SHALL instead name the Codex sandbox mode and say that approvals are disabled, so a command the sandbox refuses fails with `Operation not permitted` and is not approved at runtime."
- **Check command and tool rules in the brief: Codex refused command** (scenario from test/loop/brief.test.ts ("a codex launch under daemon commits gets the sandbox paragraph and read-only git text"); src/brief/compose.ts (line 218)):
  - sentence 8, explicit ("It" made explicit as "The workspace section of a `codex` launch", "such a command" as "a command the sandbox refuses"): "It SHALL tell the agent not to retry such a command but to ask with a `needsAccess` question naming it." → "The workspace section of a `codex` launch SHALL tell the agent not to retry a command the sandbox refuses but to ask with a `needsAccess` question naming it."
  - sentence 9, explicit ("It" made explicit as "The workspace section of a `codex` launch"): "It SHALL also say that the operator can run the command or change `runner.codex.sandbox` for the next launch." → "The workspace section of a `codex` launch SHALL also say that the operator can run the command or change `runner.codex.sandbox` for the next launch."
- **Check command and tool rules in the brief: OpenCode derived patterns** (scenario from test/loop/brief.test.ts ("an opencode brief under derived names the orchestrator_ tools, the deny wording, the derived patterns and the check command"); test/fixtures/brief/opencode-derived.md):
  - sentence 10, unchanged: "For an `opencode` launch the workspace section SHALL carry no Bash rules either."
  - sentence 11, explicit ("it" made explicit as "the workspace section of an `opencode` launch"): "Under `runner.opencode.permission: derived` it SHALL list the bash patterns the runner's ruleset allows (`git *` and the patterns derived from the same rules the OpenCode runner is given: `Bash(x:*)` as `x *`, `Bash(x)` as `x`), next to the file tools and the orchestrator tools, and say every other command is rejected." → "Under `runner.opencode.permission: derived` the workspace section of an `opencode` launch SHALL list the bash patterns the runner's ruleset allows (`git *` and the patterns derived from the same rules the OpenCode runner is given: `Bash(x:*)` as `x *`, `Bash(x)` as `x`), next to the file tools and the orchestrator tools, and say every other command is rejected."
- **Check command and tool rules in the brief: OpenCode allow and claimed launches** (scenario from test/loop/brief.test.ts ("an opencode brief under allow says every command is allowed and lists no patterns"); test/fixtures/brief/opencode-allow.md (line 25)):
  - sentence 12, explicit ("it" made explicit as "the workspace section of an `opencode` launch"): "Under `allow` it SHALL say every command and tool is allowed and list no patterns." → "Under `allow` the workspace section of an `opencode` launch SHALL say every command and tool is allowed and list no patterns."
  - sentence 13, explicit ("Both forms" made explicit as "Both forms of the `opencode` workspace section"): "Both forms SHALL state that a worker holding a claimed launch runs under its own permissions instead." → "Both forms of the `opencode` workspace section SHALL state that a worker holding a claimed launch runs under its own permissions instead."
- **Check command and tool rules in the brief: OpenCode retry diagnosis** (scenario from test/loop/brief.test.ts ("an opencode brief under derived ...": the retry brief contains "(model, login, MCP setup, permission rules)"); src/brief/compose.ts (line 262)):
  - sentence 14, explicit ("A retry brief's" made explicit as "An `opencode` launch's retry brief's": the sentence stands in the OpenCode part of the description, and src/brief/compose.ts (line 262) names "permission rules" for an `opencode` launch and "sandbox" for every other kind): "A retry brief's runner diagnosis line SHALL name permission rules rather than a sandbox among the causes outside the worktree." → "An `opencode` launch's retry brief's runner diagnosis line SHALL name permission rules rather than a sandbox among the causes outside the worktree."

#### Agent environment

Stays in the MODIFIED description:

  - sentence 1 (the list lead-in), unchanged: "A launch the daemon spawns SHALL inherit the daemon's environment with these changes:"
  - sentence 2, unchanged: "- `ORCH_HOME` replaced by a directory inside the run's data directory;"
  - sentence 3, unchanged: "- `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` and `ORCH_RUN_ID` removed on every store kind;"
  - sentence 6, unchanged: "- the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID`, and `ORCH_WORKTREE` added."

- **Agent environment: withheld store variables** (scenario from test/runs/child-env.test.ts ("the codex claim's env block and agentEnv follow the switch ...", and the same for opencode)):
  - lead-in, repeated (the list is split between its items; see Splits and lead-ins): "A launch the daemon spawns SHALL inherit the daemon's environment with these changes:"
  - sentence 4, unchanged: "- while the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS`, and every variable whose value is the resolved store URL removed (specs/state-backend "No store URL in child environments"), for every runner kind."
- **Agent environment: store variables passed without withholding** (scenario from test/runs/child-env.test.ts ("the codex claim's env block and agentEnv follow the switch ...", the withholding-off half)):
  - lead-in, repeated (the list is split between its items; see Splits and lead-ins): "A launch the daemon spawns SHALL inherit the daemon's environment with these changes:"
  - sentence 5, explicit (given the list lead-in (see Splits and lead-ins); "it" made explicit as "the daemon", "they" as the variables the item before names; "While" lowercased and the "- " list marker added, since the sentence now opens its own list item; its closing ";" becomes "."): "While it does not withhold (a SQLite store with no Postgres input), they are passed unchanged;" → "- while the daemon does not withhold (a SQLite store with no Postgres input), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS`, and every variable whose value is the resolved store URL are passed unchanged."
- **Agent environment: claim env block** (scenario from test/slice/codex-work.test.ts ("a codex claim carries the commit policy, the runner.codex settings, and the agent environment"); hosts/codex/bin/work.mjs (`agentProcessEnv` deletes empty values)):
  - sentence 7, explicit ("the same changes" made explicit as "the same changes as the environment a launch the daemon spawns inherits"): "The `env` block of a codex or opencode claim SHALL carry the same changes." → "The `env` block of a codex or opencode claim SHALL carry the same changes as the environment a launch the daemon spawns inherits."
  - sentence 8, unchanged: "A removed name appears there as an empty value, which the work loop deletes."
  - sentence 9, unchanged: "A name that is passed does not appear there at all, so the worker's own value stays."
- **Agent environment: no run of the user's** (scenario from src/runs/childEnv.ts (`isolationEnv`, `CLIENT_VARS`); src/loop/orchestrator.ts (`agentEnv`); src/runner/subprocess.ts (empty values deleted)):
  - sentence 10, unchanged: "An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's."
  - sentence 12, unchanged: "What a spawned agent running as the daemon's user can still reach of the store's credentials is stated in specs/state-backend "Store credentials a child can still reach"."
- **Agent environment: ORCH_API kept** (scenario from src/loop/orchestrator.ts (`agentEnv`: `ORCH_API: this.apiBaseUrl`)):
  - sentence 11, unchanged: "`ORCH_API` SHALL remain set so the shim reaches the agent's own daemon."
- **Agent environment: MCP server environment** (scenario from src/runner/codex.ts (`writeCodexShimEnv`, `--orch-env-file`); test/slice/shim.test.ts ("started with --orch-env-file, forwards with the token from the file")):
  - sentence 13, unchanged: "An MCP server that the agent's CLI spawns SHALL be assumed to receive only what the runner forwards to it explicitly, unless the CLI is known to pass its whole environment on."
  - sentence 14, unchanged: "Codex passes the server a fixed set of variables plus its `env` entries."
- **Agent environment: OpenCode runner forwards nothing** (scenario from test/runner/opencode.test.ts ("passes the per-launch config in OPENCODE_CONFIG_CONTENT, the brief on stdin, and the token only in the environment")):
  - sentence 15, unchanged: "OpenCode passes the MCP child its whole environment plus the server's `environment`, so the OpenCode runner SHALL forward nothing: it puts the shim's variables in the agent environment, registers the server with no `environment` block, and keeps the token off argv and out of every file."
- **Agent environment: one shimEnv helper** (scenario from test/runner/codex.test.ts ("both runners take shimEnv and shimCommand from shim-command.ts", for claude-code.ts and codex.ts); src/runner/opencode.ts (line 17 imports `shimEnv` from `./shim-command.js`, line 370 uses it)):
  - sentence 16, unchanged: "The runners SHALL build the shim's variables through one `shimEnv` helper."

#### Inbox notices handed out once

Stays in the MODIFIED description:

  - sentence 1, unchanged: "An inbox read SHALL take the notices the launch holds, wait until everything committed so far is durable, remove only the notices it took, and wait for that removal to be durable."
  - sentence 2, unchanged: "A notice queued during the wait SHALL stay for the next read."
  - sentence 3, unchanged: "Inbox reads of one launch SHALL run one at a time, so each notice is handed out once."

- **Inbox notices handed out once: caller gone** (scenario from test/slice/durability.test.ts ("an inbox read abandoned during the durable wait removes nothing: the next read delivers the notice")):
  - sentence 4, unchanged: "A notice SHALL be removed from the launch only when its answer goes to a caller whose connection is still open."
  - sentence 5, unchanged: "When the caller is gone after the first wait, the read SHALL remove nothing."
  - sentence 6, unchanged: "When the caller is gone after the removal's wait, the read SHALL put the removed notices back at the front of the launch's notices, ahead of any queued meanwhile."
  - sentence 7, unchanged: "Either way the next read SHALL hand them out."

#### Limit change notice

Stays in the MODIFIED description:

  - sentence 1, unchanged: "When an accepted configuration patch changes the value in force of `budgets.maxLaunchMs`, `health.stuckAfterMs` or `health.stuckFailAfterMs`, the daemon SHALL queue one inbox notice to each affected launch: `{ kind: 'nudge', source: 'config', message, changed, limits }`."
  - sentence 2, unchanged: "`changed` SHALL list the dotted names of the limits whose value in force changed."

- **Limit change notice: limits field** (scenario from test/loop/health.test.ts ("in pull mode a parked launch gets the notice, and returns it on its first inbox call after the claim")):
  - sentence 3, unchanged: "`limits` SHALL hold the three values now in force, nested like the config file: `{ budgets: { maxLaunchMs }, health: { stuckAfterMs, stuckFailAfterMs } }`."
- **Limit change notice: message** (scenario from test/loop/health.test.ts ("a changed time budget queues one nudge per live launch, with the values in force and the elapsed time; the same value again queues nothing"); src/loop/orchestrator.ts (`limitNotices`, line 748)):
  - sentence 4, unchanged: "`message` SHALL state, for each changed limit, the old and the new value in milliseconds, SHALL say that 0 means the limit is off, and for the time budget SHALL give the launch's elapsed time, with time the daemon did not run left out as at the time budget check."
- **Limit change notice: affected launches** (scenario from test/loop/health.test.ts ("a waiting task's launch gets the notice; an ended launch gets none")):
  - sentence 5, unchanged: "The affected launches SHALL be every launch with status `live` or `launching` that holds the lease of a `running` or `waiting` task, and every launch with status `claimable`."
- **Limit change notice: queued with the override document** (scenario from test/loop/health.test.ts ("a changed time budget queues one nudge per live launch ..."); src/loop/orchestrator.ts (`setConfig`: one transaction holding the `operator.config` event, the document and the notices)):
  - sentence 6, unchanged: "The notices SHALL be queued in the store transaction that writes the override document, each with its `launch.notice` event; no other operator event SHALL be appended."
- **Limit change notice: patches that queue nothing** (scenario from test/loop/health.test.ts ("a changed time budget queues one nudge per live launch ...": the same values and an empty patch queue nothing)):
  - sentence 7, unchanged: "A patch that changes no value in force of the three limits, a patch of any other key, and a refused patch SHALL queue nothing."
- **Limit change notice: delivered once** (scenario from test/loop/health.test.ts ("with endLive the lowering is applied, recorded on the event, not stored, and the next tick ends the launch", "a changed time budget queues one nudge per live launch ...")):
  - sentence 8, unchanged: "The notice SHALL be delivered once, like any notice, and nothing in the daemon SHALL depend on it being read."

## Capabilities

### New Capabilities

### Modified Capabilities

- `agent-protocol`: ten requirements have their descriptions cut to one behavior each ("Brief validation and remediation", "Inbox notices for health", "Revision context in the brief", "Proposals in the report", "Worker access", "Interrupted context in the brief", "Check command and tool rules in the brief", "Agent environment", "Inbox notices handed out once", "Limit change notice"); the moved behaviors become 33 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-agent-protocol-2/`. No code changes. The change is archived after the milestone review.
