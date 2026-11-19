## MODIFIED Requirements

### Requirement: Brief validation and remediation
The brief template SHALL declare slots with a source, a `required` flag, and a minimum length, and the orchestrator SHALL validate a task against them when it becomes ready, or at ingest in strict mode. When validation fails, the configured policy SHALL either block the task with reason `insufficientSpec` listing the missing slots, or invoke the remediation hook to produce the missing content stored as a payload overlay keyed by graph revision.

#### Scenario: Missing acceptance criteria blocks
- **WHEN** a ready task's payload has no acceptance criteria and the policy is `block`
- **THEN** the task is `blocked` with reason `insufficientSpec` listing `acceptanceCriteria`

#### Scenario: Review-mode candidate
- **WHEN** the policy is `remediate` in `review` mode and the hook returns a candidate
- **THEN** the task is `blocked` with kind `needsDecision` carrying the candidate, and unblock applies it to the payload overlay

### Requirement: Inbox notices for health
The inbox SHALL deliver notices of kind `stuck` with `idleMs` and a `message`, `nudge` with the operator's `message`, `baseMoved` with the new integration `head` and the `files` its commit touched, and `payloadChanged` with the new graph `rev`. The brief's workspace section SHALL state that such notices may arrive in the inbox, name the four kinds, and tell the agent to check `inbox` after long steps.

#### Scenario: Nudge reaches the agent on its next inbox call
- **WHEN** an operator nudges a running task with "commit what you have"
- **THEN** the agent's next `inbox` call returns `{ kind: 'nudge', message: 'commit what you have' }` and the notice is not returned again

#### Scenario: Brief names the notices and allows rebasing
- **WHEN** a brief is composed for a launch with the `agent` commit policy
- **THEN** its workspace section names `stuck`, `nudge`, `baseMoved`, and `payloadChanged` and says the launch branch may be rebased onto the integration head

#### Scenario: Codex brief under daemon commits does not allow rebasing
- **WHEN** a brief is composed for a `codex` launch with `commitPolicy: daemon`
- **THEN** it names the four notice kinds, forbids merging into, pushing to, or checking out the integration branch, does not say "You may rebase", and says the orchestrator rebases the branch at verification

### Requirement: Revision context in the brief
When a task is relaunched after reopen, uncancel, or a cascade reset, its brief SHALL carry a `revision` context with `cause` of `reopened` or `upstreamReopened`, `upstream` naming the reopened task when the cause is `upstreamReopened`, `priorLaunchId`, `priorBranch`, and, when they exist, `priorPublishedSha` and `priorReportSummary`.

#### Scenario: Cascade dependent is briefed to revise
- **WHEN** T2 was published at sha P with summary S and is reset by a cascade reopen of T1
- **THEN** T2's next brief carries `revision` with cause `upstreamReopened`, upstream T1, `priorPublishedSha` P, and `priorReportSummary` S, and states that P is contained in the new `baseSha`

#### Scenario: Killed dependent is briefed with its branch
- **WHEN** T2 was running on branch `task/T2/l1` and is reset by a cascade
- **THEN** T2's next brief carries `revision` with `priorBranch` `task/T2/l1` and no `priorPublishedSha`

### Requirement: Proposals in the report
The submit report MAY carry `proposals`, a list of `{ title, description, acceptanceCriteria, deps?, scope?, labels? }` where `title`, `description`, and at least one acceptance criterion are required and every id in `deps` MUST name a node in the launch's graph revision. A report that violates this SHALL be answered 400 as malformed and the task SHALL stay `running`. `followUps` SHALL remain free text.

#### Scenario: Proposals stored pending
- **WHEN** T2's submit report carries two valid proposals
- **THEN** T2 is `submitted`, proposals `T2-p1` and `T2-p2` are pending, and the graph is unchanged

#### Scenario: Malformed proposal rejects the report
- **WHEN** a submit report carries a proposal with no acceptance criteria or with a dependency on an id the graph does not have
- **THEN** the response is 400 naming the proposal and the task is still `running`

### Requirement: Worker access
A worker that holds a claimed launch SHALL use the same five operations with the launch token, either directly against the loopback API or through the token-scoped operator tools, and SHALL be subject to the same scoping, deduplication, sealing, and fencing rules as a spawned agent.

#### Scenario: Worker submits through the operator server
- **WHEN** a worker commits in the worktree and calls `launch_report` with kind `submit` and its token
- **THEN** the submission is sealed and the task is `submitted` exactly as for a spawned agent

#### Scenario: Worker loop registers the façade for its agent
- **WHEN** the Codex work loop claims a codex launch and runs `codex exec` for it
- **THEN** the command registers the shim as `mcp_servers.orchestrator` with the launch's env file, the agent reports through `orchestrator.report`, and the daemon spawned no process for the launch

#### Scenario: Fallback file is not read for a claimed launch
- **WHEN** a worker writes `.orchestrator/report.json` with a submit and stops calling the API
- **THEN** the lease expires, the task is `failed` with reason `leaseExpired`, and the file is swept with the worktree

#### Scenario: Worker fenced after release
- **WHEN** a launch is released and its former worker calls `launch_heartbeat` with the old token
- **THEN** the response is 401 and nothing changes

### Requirement: Interrupted context in the brief
When a task is relaunched after a release with `keep`, its brief SHALL carry an `interrupted` context with `priorLaunchId`, `priorBranch`, `headSha`, `reason`, and `wipCommit` when uncommitted changes were preserved.

#### Scenario: Brief names the kept branch
- **WHEN** T2's launch `L1` on branch `task/T2/l1` was released with `keep` at head H with a work-in-progress commit W and T2 is relaunched
- **THEN** T2's next brief carries `interrupted` with `priorLaunchId` L1, `priorBranch` `task/T2/l1`, `headSha` H, and `wipCommit` W, and states that the branch holds the work so far

#### Scenario: Context cleared at the next launch
- **WHEN** the relaunched T2 goes live
- **THEN** its overlay entry no longer carries `interrupted`

#### Scenario: Interrupted while waiting
- **WHEN** T3 was released with `keep` while `waiting` and is later answered and relaunched
- **THEN** its brief carries the question, the answer, and `interrupted`

### Requirement: Check command and tool rules in the brief
The brief's definition of done SHALL name the effective check command at the time the brief is composed. When `checkCommand` is unresolved the brief SHALL say that no check command is configured for the repository yet, that the operator is being asked, and that the agent must run the project's documented test suite before submitting.

#### Scenario: Detected command in the brief
- **WHEN** a brief is composed for a spawned claude-code launch in a repository whose detected check command is `npm test`
- **THEN** its definition of done says to run `npm test` before submitting and its workspace section lists `Bash(npm test:*)` among the rules

#### Scenario: Unresolved command in the brief
- **WHEN** a brief is composed while `checkCommand` is unresolved
- **THEN** it says no check command is configured yet and instructs the agent to run the project's documented tests before submitting

#### Scenario: Later brief reflects the change
- **WHEN** the operator sets `checkCommand` after T1's brief was written and T2 is prepared afterwards
- **THEN** T2's brief names the new command and T1's brief in its worktree is unchanged

#### Scenario: Codex sandbox in the brief
- **WHEN** a brief is composed for a `codex` launch whose sandbox is `workspace-write`
- **THEN** its workspace section names the sandbox `workspace-write`, says a refused command fails with `Operation not permitted` and is not approved at runtime, tells the agent to ask with a `needsAccess` question naming the command, and does not say that Bash rules are in force

#### Scenario: OpenCode derived patterns in the brief
- **WHEN** an `opencode` launch is prepared under `permission: derived` with the rules `Bash(npm test:*)` and `Bash(git status)`
- **THEN** `brief.json` carries `runner.permission` `{ mode: derived, bashPatterns }` starting with `git *`, and the workspace section lists `npm test *`, `git status`, and the check command's own pattern

#### Scenario: OpenCode allow in the brief
- **WHEN** an `opencode` launch is prepared under `permission: allow`
- **THEN** the workspace section says every command is allowed and lists no patterns

### Requirement: Agent environment
A launch the daemon spawns SHALL inherit the daemon's environment with these changes:
- `ORCH_HOME` replaced by a directory inside the run's data directory;
- `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` and `ORCH_RUN_ID` removed on every store kind;
- the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID`, and `ORCH_WORKTREE` added.

#### Scenario: Agent sees an isolated home
- **WHEN** a spawned agent's command writes `$ORCH_HOME` to a file
- **THEN** the path is inside the run's data directory, not the user's `~/.orchestrator`, and `ORCH_URL` is unset in the agent's environment

#### Scenario: Agent cannot list the user's runs
- **WHEN** a spawned agent runs `orchestrator-ctl runs`
- **THEN** the result lists no runs

#### Scenario: Agent sees no store URL
- **WHEN** a daemon that withholds has `DATABASE_URL` and `APP_DATABASE` set to the store URL, `DATABASE_URL_FILE`, and every name in `LIBPQ_VARS` with `PGPASSWORD` set in its environment, and a spawned agent's command prints its environment
- **THEN** the printout has none of those variables, not the password and not the `PGPASSWORD` value

#### Scenario: Agent on a SQLite run keeps the project's database variables
- **WHEN** a daemon with a SQLite store and no Postgres input has `DATABASE_URL`, `APP_DATABASE` set to the same value, `DATABASE_URL_FILE`, `PGHOST` and `PGPASSWORD` in its environment, and a spawned agent's command prints its environment; or a codex or opencode worker claims a launch from that daemon
- **THEN** the printout holds each of them with its value and no `ORCH_URL` or `ORCH_RUN_ID` line; the claim's `env` block has no key for any of them and has `ORCH_RUN_ID` empty

### Requirement: Inbox notices handed out once
An inbox read SHALL take the notices the launch holds, wait until everything committed so far is durable, remove only the notices it took, and wait for that removal to be durable. A notice queued during the wait SHALL stay for the next read. Inbox reads of one launch SHALL run one at a time, so each notice is handed out once.

#### Scenario: Notice queued during the wait
- **WHEN** a second nudge is queued while an inbox read waits for durability
- **THEN** that read answers with the first nudge only, and the next read answers with the second

#### Scenario: Concurrent reads
- **WHEN** two inbox reads of one launch run at once while one notice is held
- **THEN** the notice is handed out by exactly one of them

#### Scenario: Read abandoned during a stall
- **WHEN** a nudge is durable, the sink stalls, the agent's inbox read waits, and the agent gives up and closes the connection before the sink recovers
- **THEN** once the sink recovers the nudge is still held by the launch, and the next read answers with it

#### Scenario: Caller gone while the removal waits
- **WHEN** two nudges are taken, the sink stalls on the batch that removes them, a third nudge is queued, and the caller goes away before the removal is durable
- **THEN** the read removes nothing for good, and the next read answers with the three nudges in order

### Requirement: Limit change notice
When an accepted configuration patch changes the value in force of `budgets.maxLaunchMs`, `health.stuckAfterMs` or `health.stuckFailAfterMs`, the daemon SHALL queue one inbox notice to each affected launch: `{ kind: 'nudge', source: 'config', message, changed, limits }`. `changed` SHALL list the dotted names of the limits whose value in force changed.

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

## ADDED Requirements

### Requirement: Brief validation and remediation: review and auto modes
In `review` mode (default) the remediation hook's candidate SHALL land as `blocked` with kind `needsDecision` for a human to accept, edit, or reject; in `auto` mode it SHALL launch directly.

#### Scenario: Auto-mode candidate launches
- **WHEN** the policy is `remediate` in `auto` mode and the hook returns a candidate for the missing `acceptanceCriteria`
- **THEN** the task is `running` without being blocked, and its brief's payload carries the candidate's `acceptanceCriteria"

### Requirement: Brief validation and remediation: default hook
v1 SHALL ship the remediation hook interface with a default that blocks.

#### Scenario: Default hook blocks
- **WHEN** the policy is `remediate`, no remediator is configured, and a ready task's payload has no acceptance criteria
- **THEN** the default hook returns no candidate and the task is `blocked` with reason `insufficientSpec` listing `acceptanceCriteria`

### Requirement: Inbox notices for health: integration branch rules
The brief SHALL state that merging into, pushing to, or checking out the integration branch is not allowed. Under the `agent` commit policy the brief SHALL state that rebasing the launch branch onto the integration head is allowed. Under `daemon` the brief SHALL instead state that the orchestrator rebases the branch onto the integration head at verification.

#### Scenario: Codex brief under agent commits allows rebasing
- **WHEN** a brief is composed for a `codex` launch with `commitPolicy: agent`
- **THEN** it forbids merging into, pushing to, or checking out the integration branch and says "You may rebase your launch branch onto it"

### Requirement: Revision context in the brief: revise the prior work
The brief that carries a `revision` context SHALL state that the prior published commit remains on the integration branch and is contained in `baseSha`, and SHALL instruct the agent to revise the prior work rather than redo it.

#### Scenario: Reopened task told to revise
- **WHEN** a brief is composed with a `revision` context of cause `upstreamReopened`, upstream T1 and `priorPublishedSha` P1, for a launch whose `baseSha` is B
- **THEN** it says that upstream task T1 was reopened, that P1 remains on the integration branch and is contained in B, and "Revise the prior work rather than redoing it"

### Requirement: Revision context in the brief: stored with the attempt context
The `revision` context SHALL be stored on the overlay entry at reset and cleared when the launch goes live, like other attempt context.

#### Scenario: Revision context kept until the launch goes live
- **WHEN** a cascade reopen of T1 resets T1 and T2, and T1 is relaunched
- **THEN** the reset stores `revision` on each task's entry, T1's new launch is briefed with it, and the entry carries no `revision` once that launch is live

### Requirement: Proposals in the report: stored pending
When the submit report is accepted each proposal SHALL be stored as pending with id `<taskId>-p<n>`, where `n` counts the task's proposals from one, and the orchestrator SHALL NOT add any node to the graph on its own.

#### Scenario: Proposal ids and an unchanged graph file
- **WHEN** a task T2 run from a graph file submits a report with two valid proposals and the report is accepted
- **THEN** the pending proposals are `T2-p1` and `T2-p2`, two `proposal.created` events are recorded, and the graph file is byte for byte as before

### Requirement: Worker access: no façade spawned for a claimed launch
The daemon SHALL NOT spawn the per-launch MCP façade for a claimed launch. A worker loop that runs the agent as its own process, such as the Codex work loop, MAY register the façade for that process the way the runner of that kind registers it for a spawned launch, with the launch's identity in the same env file, so that the agent sees the same tool names.

#### Scenario: Claimed launch has no process of the daemon's
- **WHEN** a pull-mode launch is parked and a worker claims it
- **THEN** the claim answers with the launch's token, worktree and brief, the launch is `live` with the worker and no pid, and the worker's `heartbeat` with the token is answered 200

### Requirement: Worker access: no fallback file for workers
The fallback file SHALL NOT be available to workers: the orchestrator reads `.orchestrator/report.json` only when it finds a launch's process dead, and a claimed launch has no process the daemon watches, so a worker that cannot reach the API SHALL keep retrying until the daemon answers or its lease expires.

#### Scenario: Claimed launch survives a daemon restart
- **WHEN** the daemon restarts while a worker holds a claimed launch
- **THEN** the launch is still `live` with no pid and the worker's next call with its token is answered 200; a launch whose worker stops calling expires with reason `leaseExpired`

### Requirement: Worker access: one brief for spawned and claimed launches
The brief SHALL be the same document for spawned and claimed launches, and the worker instructions SHALL override the brief's fallback-file guidance.

#### Scenario: Worker preamble overrides the fallback file
- **WHEN** the Codex work loop composes its preamble for a claimed launch
- **THEN** the preamble names the launch and task, the 401 rule, and says "Never write a fallback report file"

### Requirement: Interrupted context in the brief: continue from the kept branch
A brief carrying an `interrupted` context SHALL state that the previous launch was interrupted for its `reason`, that the branch holds its work so far at `headSha` and that the work-in-progress commit, when present, holds changes the previous worker had not committed, and SHALL instruct the agent to continue from that branch by merging or cherry-picking it onto the new base, or to inspect it and start over, and to squash the work-in-progress commit before submitting.

#### Scenario: Brief tells the agent to continue or start over
- **WHEN** a brief is composed with an `interrupted` context naming launch L1, branch `task/T2/l1`, head H1, work-in-progress commit W1 and reason `sessionEnded`
- **THEN** it says that launch L1 was interrupted (`sessionEnded`), that `task/T2/l1` holds the work so far at H1, that W1 is a work-in-progress commit, and to squash the work-in-progress commit before submitting

### Requirement: Interrupted context in the brief: stored with the attempt context
The `interrupted` context SHALL be stored on the overlay entry at the release and cleared when the next launch goes live, like other attempt context, and SHALL coexist with a question and answer when the release happened while `waiting`.

#### Scenario: Kept release stores the context until the next claim
- **WHEN** a claimed launch of T1 that made progress is released with `keep` and T1's next launch is claimed
- **THEN** T1's entry carries `interrupted` with the prior launch, branch, head, work-in-progress commit and reason after the release, the parked launch's brief carries it, and the entry carries no context once the next launch is claimed

### Requirement: Check command and tool rules in the brief: Claude Code Bash rules
For spawned launches whose runner carries an allow list (the Claude Code runner), the brief's workspace section SHALL list the Bash rules in force, stating that a worker holding a claimed launch runs under its own permissions instead.

#### Scenario: Bash rules and the worker's own permissions
- **WHEN** a brief is composed for a spawned launch whose allow list holds `Bash(git:*)`, `Bash(npm test:*)` and `Bash(node:*)`
- **THEN** its workspace section says these Bash rules are in force, names the three rules, and says a worker holding a claimed launch runs under its own permissions

### Requirement: Check command and tool rules in the brief: Claude Code command guidance
The brief's workspace section for a spawned launch whose runner carries an allow list SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own. The brief's workspace section for a spawned launch whose runner carries an allow list SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it.

#### Scenario: Commands without cd and a needsAccess question
- **WHEN** a brief is composed for a spawned launch whose allow list holds `Bash(npm test:*)`
- **THEN** its workspace section tells the agent to run commands without `cd` and to ask with a `needsAccess` question naming the command

### Requirement: Check command and tool rules in the brief: Codex sandbox
For a `codex` launch the workspace section SHALL carry no Bash rules. The workspace section of a `codex` launch SHALL instead name the Codex sandbox mode and say that approvals are disabled, so a command the sandbox refuses fails with `Operation not permitted` and is not approved at runtime.

#### Scenario: Codex brief names its sandbox and carries no Bash rules
- **WHEN** a brief is composed for a `codex` launch whose sandbox is `danger-full-access`
- **THEN** its workspace section says the agent runs under the Codex sandbox `danger-full-access` with approvals disabled, and `brief.json` carries no `allowedTools`

### Requirement: Check command and tool rules in the brief: Codex refused command
The workspace section of a `codex` launch SHALL tell the agent not to retry a command the sandbox refuses but to ask with a `needsAccess` question naming it. The workspace section of a `codex` launch SHALL also say that the operator can run the command or change `runner.codex.sandbox` for the next launch.

#### Scenario: Codex brief names the way out of a refusal
- **WHEN** a brief is composed for a `codex` launch whose sandbox is `workspace-write`
- **THEN** its workspace section says "Do not retry it; ask with a `needsAccess` question naming the command." and that the operator can run it for you, or change `runner.codex.sandbox` for your next launch

### Requirement: Check command and tool rules in the brief: OpenCode derived patterns
For an `opencode` launch the workspace section SHALL carry no Bash rules either. Under `runner.opencode.permission: derived` the workspace section of an `opencode` launch SHALL list the bash patterns the runner's ruleset allows (`git *` and the patterns derived from the same rules the OpenCode runner is given: `Bash(x:*)` as `x *`, `Bash(x)` as `x`), next to the file tools and the orchestrator tools, and say every other command is rejected.

#### Scenario: OpenCode derived brief lists the patterns and the tools
- **WHEN** a brief is composed for an `opencode` launch under `permission: derived` with the bash patterns `npm test *` and `git status` and the check command `npm test`
- **THEN** its workspace section says the rules allow the file tools (read, glob, grep, list, edit, write), the orchestrator tools, and the bash commands `npm test *`, `git status` and `npm test`, says every other command is denied, and does not mention a sandbox

### Requirement: Check command and tool rules in the brief: OpenCode allow and claimed launches
Under `allow` the workspace section of an `opencode` launch SHALL say every command and tool is allowed and list no patterns. Both forms of the `opencode` workspace section SHALL state that a worker holding a claimed launch runs under its own permissions instead.

#### Scenario: OpenCode brief under allow
- **WHEN** a brief is composed for an `opencode` launch under `permission: allow`
- **THEN** its workspace section says the rules allow every command and every tool, lists no bash commands, and says a worker holding a claimed launch runs under its own permissions instead

### Requirement: Check command and tool rules in the brief: OpenCode retry diagnosis
An `opencode` launch's retry brief's runner diagnosis line SHALL name permission rules rather than a sandbox among the causes outside the worktree.

#### Scenario: OpenCode retry brief names permission rules
- **WHEN** an `opencode` launch's brief is composed after a runner failure with a diagnosis
- **THEN** its diagnosis line lists "(model, login, MCP setup, permission rules)" among the causes outside the worktree, where the brief of another runner kind names a sandbox

### Requirement: Agent environment: withheld store variables
A launch the daemon spawns SHALL inherit the daemon's environment with these changes:
- while the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS`, and every variable whose value is the resolved store URL removed (specs/state-backend "No store URL in child environments"), for every runner kind.

#### Scenario: Codex claim env blanks the store variables
- **WHEN** a daemon that withholds has `DATABASE_URL`, `DATABASE_URL_FILE` and `PGHOST` set, and a codex or opencode worker claims a launch
- **THEN** the claim's `env` block and the daemon's agent environment for that launch give each of them an empty value

### Requirement: Agent environment: store variables passed without withholding
A launch the daemon spawns SHALL inherit the daemon's environment with these changes:
- while the daemon does not withhold (a SQLite store with no Postgres input), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS`, and every variable whose value is the resolved store URL are passed unchanged.

#### Scenario: Claim env without withholding
- **WHEN** withholding is off and a codex or opencode worker claims a launch
- **THEN** the claim's `env` block and the daemon's agent environment have no key `DATABASE_URL`, `DATABASE_URL_FILE` or any name in `LIBPQ_VARS`, and still give `ORCH_RUN_ID` and `ORCH_URL` an empty value

### Requirement: Agent environment: claim env block
The `env` block of a codex or opencode claim SHALL carry the same changes as the environment a launch the daemon spawns inherits. A removed name appears there as an empty value, which the work loop deletes. A name that is passed does not appear there at all, so the worker's own value stays.

#### Scenario: Codex claim carries the agent environment
- **WHEN** a codex worker claims a launch under `commitPolicy: daemon`
- **THEN** the claim's `codex.env` holds `ORCH_TOKEN` equal to the claim's token and `ORCH_COMMIT_POLICY` `daemon`, and the work loop deletes every name whose value there is empty before it starts the agent

### Requirement: Agent environment: no run of the user's
An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's. What a spawned agent running as the daemon's user can still reach of the store's credentials is stated in specs/state-backend "Store credentials a child can still reach".

#### Scenario: Agent environment points at an isolated home
- **WHEN** the daemon composes the agent environment of a launch
- **THEN** `ORCH_HOME` names a directory inside the run's data directory and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` and `ORCH_RUN_ID` are empty values, which the runner deletes

### Requirement: Agent environment: ORCH_API kept
`ORCH_API` SHALL remain set so the shim reaches the agent's own daemon.

#### Scenario: Agent environment names the daemon's API
- **WHEN** the daemon composes the agent environment of launch L
- **THEN** `ORCH_API` is the daemon's API base URL, beside `ORCH_LAUNCH_ID` L, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID` and `ORCH_WORKTREE`

### Requirement: Agent environment: MCP server environment
An MCP server that the agent's CLI spawns SHALL be assumed to receive only what the runner forwards to it explicitly, unless the CLI is known to pass its whole environment on. Codex passes the server a fixed set of variables plus its `env` entries.

#### Scenario: Codex shim reads its variables from the env file
- **WHEN** the Codex runner prepares a launch
- **THEN** it writes the shim's variables to the launch's env file with mode 0600 and registers the shim with `--orch-env-file` naming that file, and the shim started that way forwards calls with the token from the file

### Requirement: Agent environment: OpenCode runner forwards nothing
OpenCode passes the MCP child its whole environment plus the server's `environment`, so the OpenCode runner SHALL forward nothing: it puts the shim's variables in the agent environment, registers the server with no `environment` block, and keeps the token off argv and out of every file.

#### Scenario: OpenCode token only in the environment
- **WHEN** the OpenCode runner spawns a launch
- **THEN** the per-launch config registers the `orchestrator` server with no `environment` block, the config and argv do not hold the token, and the agent's environment does

### Requirement: Agent environment: one shimEnv helper
The runners SHALL build the shim's variables through one `shimEnv` helper.

#### Scenario: Runners import shimEnv
- **WHEN** the sources of the Claude Code, Codex and OpenCode runners are read
- **THEN** each imports `shimEnv` from `./shim-command.js` and builds the shim's variables with it

### Requirement: Inbox notices handed out once: caller gone
A notice SHALL be removed from the launch only when its answer goes to a caller whose connection is still open. When the caller is gone after the first wait, the read SHALL remove nothing. When the caller is gone after the removal's wait, the read SHALL put the removed notices back at the front of the launch's notices, ahead of any queued meanwhile. Either way the next read SHALL hand them out.

#### Scenario: Abandoned read hands out nothing
- **WHEN** an inbox read is waiting for durability and its caller closes the connection
- **THEN** the launch still holds the notice, and the next read answers with it and a read after that answers with none

### Requirement: Limit change notice: limits field
`limits` SHALL hold the three values now in force, nested like the config file: `{ budgets: { maxLaunchMs }, health: { stuckAfterMs, stuckFailAfterMs } }`.

#### Scenario: Values in force under limits
- **WHEN** the operator sets `budgets.maxLaunchMs` to 0 while `health.stuckAfterMs` is 1000 and `health.stuckFailAfterMs` is 3000
- **THEN** the notice's `limits` is `{ budgets: { maxLaunchMs: 0 }, health: { stuckAfterMs: 1000, stuckFailAfterMs: 3000 } }`

### Requirement: Limit change notice: message
`message` SHALL state, for each changed limit, the old and the new value in milliseconds, SHALL say that 0 means the limit is off, and for the time budget SHALL give the launch's elapsed time, with time the daemon did not run left out as at the time budget check.

#### Scenario: Message with old and new values
- **WHEN** the operator changes `budgets.maxLaunchMs` from 10000 to 20000 for a live launch that has run 2000ms
- **THEN** the notice's message holds `budgets.maxLaunchMs 10000ms -> 20000ms (this launch has run 2000ms of it)` and `0 means the limit is off`, and names no `health.` limit

### Requirement: Limit change notice: affected launches
The affected launches SHALL be every launch with status `live` or `launching` that holds the lease of a `running` or `waiting` task, and every launch with status `claimable`.

#### Scenario: Ended launch gets no notice
- **WHEN** T1's launch has ended after its submit, T5's task is `waiting`, and the operator changes `health.stuckAfterMs`
- **THEN** T5's launch holds one notice naming `health.stuckAfterMs`, and T1's launch holds none and has no `launch.notice` event

### Requirement: Limit change notice: queued with the override document
The notices SHALL be queued in the store transaction that writes the override document, each with its `launch.notice` event; no other operator event SHALL be appended.

#### Scenario: One launch.notice event per notice
- **WHEN** a patch changes `budgets.maxLaunchMs` while several launches are live
- **THEN** each live launch has exactly one `launch.notice` event with payload `{ kind: 'nudge' }`, and no other operator event than `operator.config` is appended for the patch

### Requirement: Limit change notice: patches that queue nothing
A patch that changes no value in force of the three limits, a patch of any other key, and a refused patch SHALL queue nothing.

#### Scenario: An empty patch and values already in force
- **WHEN** the operator sends an empty patch, or a patch that restates the three values already in force
- **THEN** no launch gets a notice and no `launch.notice` event is appended

### Requirement: Limit change notice: delivered once
The notice SHALL be delivered once, like any notice, and nothing in the daemon SHALL depend on it being read.

#### Scenario: A lowered limit applies whether or not the notice is read
- **WHEN** the operator lowers `budgets.maxLaunchMs` below a live launch's elapsed time with `endLive` and the launch never calls `inbox`
- **THEN** the next tick ends the launch for its time budget; a launch that does read its inbox gets the notice once and none on the next read
