# Agent Protocol Specification

## Purpose
What an agent receives and how it reports back: the standalone brief, launch token scoping, deduplicated events, sealed submissions, declared no-ops, acceptance evidence, blocking and resume, the file fallback, the MCP façade, brief validation, the inbox notices of kind `stuck`, `nudge`, and `baseMoved` through which the daemon and the operator reach a running agent, the `payloadChanged` notice that tells a live agent its task's payload changed on reload, the revision context a brief carries after a reopen or a cascade reset so that the agent revises its prior work rather than redoing it, the proposals a submit report may carry for follow-up work, which the orchestrator stores pending and never adds to the graph on its own, and the worker access rules under which a worker holding a claimed launch acts as the agent through the same five operations with the launch token, directly against the loopback API or through the token-scoped operator tools, with no per-launch façade and no fallback file.

## Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer. Under `agent`, the conflict, interruption, and revision texts tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta. Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits;
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

`brief.json` SHALL carry the launch's `runner` (`kind`, `commitPolicy`, and `sandbox` for a `codex` launch). A brief composed without a runner SHALL be the `claude-code` text under the `agent` policy. The brief MUST be sufficient for a person to perform the task without any other channel.

#### Scenario: Brief carries direct dependency reports
- **WHEN** T2 is launched after T1 is done
- **THEN** T2's brief contains T1's completion report and nothing from transitive dependencies beyond a pointer to the log

#### Scenario: Retry brief carries context
- **WHEN** a task is launched for its second attempt after a verifier red check
- **THEN** the brief contains the first attempt's failure report and the check output

#### Scenario: Codex brief under daemon commits
- **WHEN** a brief is composed for a `codex` launch with `commitPolicy: daemon`, carrying interruption (with a work-in-progress commit), conflict, and revision context
- **THEN** it says the orchestrator commits uncommitted changes, tells the agent to reapply the prior branch's changes as file edits, does not contain "commit and resubmit", "squash the work-in-progress commit", or "commit the delta", and `brief.json` carries `runner.kind: codex`

### Requirement: Launch token scoping
Every API call SHALL carry a bearer token issued for one launch. A call whose token does not match the launch in the path, or whose launch has been revoked or ended, SHALL be answered with 401 and SHALL have no effect.

A runner SHALL NOT put the launch token on the argv of any process it starts. The token SHALL reach the shim through a file in `<worktree>/.orchestrator/` with mode 0600: `mcp.json` for Claude Code, or `shim.env`, named by the shim's `--orch-env-file`, for Codex.

#### Scenario: Token for another launch
- **WHEN** launch L1's token is used against launch L2's endpoints
- **THEN** the response is 401 and no event is recorded

#### Scenario: Revoked launch
- **WHEN** a launch has been revoked by recovery and its process calls `report`
- **THEN** the response is 401 and the task state is unchanged

#### Scenario: Token off argv
- **WHEN** a codex launch is spawned
- **THEN** its command line names `.orchestrator/shim.env` but does not contain the token, and the file's mode is 0600

### Requirement: Agent operations
The API SHALL expose exactly five operations on loopback: `heartbeat` with optional progress, `report` with kind `submit` or `fail`, `block` with a structured question, `inbox` returning pending notices, and `log` with free text. `inbox` SHALL be pull-based; the orchestrator SHALL never push to an agent.

#### Scenario: Heartbeat renews the lease
- **WHEN** an agent posts `heartbeat`
- **THEN** its lease `expiresAt` is extended by the TTL

#### Scenario: Inbox is pull
- **WHEN** the orchestrator has a notice for a launch
- **THEN** the notice is returned on the agent's next `inbox` call and is not delivered any other way

### Requirement: Deduplication
Every mutating call (`report`, `block`, `log`) SHALL carry `seq`, a per-launch monotone integer. The server SHALL record the event and its response under `(launchId, seq)` in one transaction before acknowledging, and SHALL return the stored response without re-applying when the same `(launchId, seq)` is received again.

#### Scenario: Lost acknowledgement
- **WHEN** an agent posts `report` with seq 3, the daemon records it but the connection drops before the response, and the agent retries seq 3
- **THEN** the retry returns the stored response and the task transitions exactly once

### Requirement: Submission sealing
On `report submit` the orchestrator SHALL inspect the worktree, ignoring `.orchestrator/`. Under the launch's `agent` commit policy, a worktree with uncommitted or untracked changes SHALL be rejected with 409 and the list of files, and the task SHALL remain `running`. Under `daemon`, the orchestrator SHALL commit those changes on the launch branch: author and committer `orchestrator`, hooks skipped, the report summary as the message. It SHALL then seal the new head, and the `agent.report` event SHALL carry `committedByOrchestrator: true`. Under either policy, a clean worktree SHALL NOT be committed. Once the worktree is clean or committed, the branch head SHALL be recorded as `sealedSha` and the task SHALL become `submitted`. Commits made after sealing SHALL be ignored by verification.

#### Scenario: Dirty worktree rejected
- **WHEN** an agent of a launch with the `agent` policy submits with an unstaged modification to `src/a.ts`
- **THEN** the response is 409 listing `src/a.ts` and the task is still `running`

#### Scenario: Dirty worktree committed by the daemon
- **WHEN** an agent of a launch with the `daemon` policy writes `T1.txt` and submits without committing
- **THEN** the response is 200, the launch branch head is a commit by `orchestrator` holding `T1.txt`, `sealedSha` is that head, and `agent.report` carries `committedByOrchestrator: true`

#### Scenario: Later commits ignored
- **WHEN** an agent submits at commit C1 and then commits C2 on the same branch
- **THEN** verification uses C1

### Requirement: Declared no-op
If `sealedSha` equals `baseSha`, the submit report MUST carry `noChanges` with a justification; otherwise the submission SHALL fail with reason `emptySubmission` and `attempts` SHALL increase. This holds under both commit policies: under `daemon`, a clean worktree is not committed, so its `sealedSha` is still `baseSha`.

#### Scenario: Undeclared empty submission fails
- **WHEN** an agent submits with no commits ahead of `baseSha` and no `noChanges`
- **THEN** the task becomes `failed` with reason `emptySubmission`

#### Scenario: Undeclared empty submission fails under daemon commits
- **WHEN** an agent of a launch with the `daemon` policy submits a clean worktree with no commits and no `noChanges`
- **THEN** no commit is made and the submission fails with reason `emptySubmission`

#### Scenario: Declared no-op passes
- **WHEN** an agent submits with no commits and `noChanges.justification` set
- **THEN** the task is `submitted` and verification passes without publishing a commit

### Requirement: Acceptance evidence
When the brief contains acceptance criteria, the submit report MUST include an `acceptance` entry with evidence for each criterion; otherwise the submission SHALL fail with reason `missingAcceptanceEvidence`. An entry covers a criterion when its `criterion` matches the criterion's text after markdown code spans and emphasis, a leading list marker, and trailing punctuation are dropped, whitespace is collapsed, and case is ignored, or when it is the criterion's 1-based position in the brief's list. The check is structural; the orchestrator does not judge the evidence.

#### Scenario: Missing evidence
- **WHEN** the brief lists two criteria and the report covers one
- **THEN** the task becomes `failed` with reason `missingAcceptanceEvidence` naming the uncovered criterion

#### Scenario: Loosely quoted criterion
- **WHEN** the brief lists the criterion "`npm test` passes." and the report's entry reads "npm test passes"
- **THEN** the criterion is covered

#### Scenario: Criterion by position
- **WHEN** the brief lists two criteria and the report's entries read "1" and "2"
- **THEN** both criteria are covered

### Requirement: Block and wait
`block` SHALL persist the question, move the task to `waiting`, release its run slot, and hold the connection open until an answer is delivered or `maxWait` elapses. An operator answer SHALL be persisted before any resume. The task SHALL return to `running`, and the long-poll SHALL complete only after the scheduler admits it. A dropped connection SHALL be recoverable by re-issuing `block` with the same `seq`, which returns the stored answer once admitted. When `maxWait` elapses, the task SHALL become `blocked` with the question preserved, and a later answer SHALL act as unblock-with-answer.

A runner whose CLI times out MCP tool calls SHALL size that timeout above `maxWait`. The Codex runner's default is `ceil(maxWaitMs/1000)+60` seconds.

#### Scenario: Answer then admission then resume
- **WHEN** an agent blocks, a human answers, and a slot is free
- **THEN** the task is `running` and the long-poll returns the answer

#### Scenario: Replay after disconnect
- **WHEN** the long-poll connection drops, a human answers, and the agent re-issues `block` with the same seq
- **THEN** the call returns the answer after admission and no second question is recorded

#### Scenario: maxWait degrades to blocked
- **WHEN** no answer arrives within `maxWait`
- **THEN** the long-poll returns a timeout, the task is `blocked` with the question, and an answer given later produces a new launch whose brief carries it

### Requirement: Fallback file
The brief and the MCP façade SHALL instruct the agent to retry the API with backoff for the retry window, and then to write `.orchestrator/report.json` and exit. The file SHALL carry `launchId`, `seq`, a kind of `submit`, `fail`, or `block`, and the body. Recovery SHALL apply the file when it finds the process dead. A fallback `submit` SHALL be sealed the way a posted one is under the launch's commit policy; under `daemon`, the `agent.fallback` event SHALL carry `committedByOrchestrator: true` when a commit was made. A fallback `block` SHALL be treated as a transition to `blocked` with the question.

#### Scenario: Offline submission applied
- **WHEN** the API is unreachable, the agent writes a `submit` fallback file and exits, and the daemon later finds the process dead
- **THEN** the submission is sealed and applied as if it had been posted

#### Scenario: Offline dirty submission under daemon commits
- **WHEN** an agent of a launch with the `daemon` policy leaves uncommitted changes, writes a `submit` fallback file, and exits
- **THEN** the daemon commits the changes, seals the new head, and applies the submission

#### Scenario: Offline question becomes blocked
- **WHEN** the agent writes a `block` fallback file and exits
- **THEN** the task is `blocked` with that question

### Requirement: MCP façade
A stdio MCP server launched per agent SHALL expose the five operations as tools, forward them to the HTTP API with the token from its environment, and retry through daemon restarts for the retry window before surfacing an error.

Started with `--orch-env-file <path>`, the façade SHALL layer the file's `KEY=VALUE` lines over its environment. When the file is missing or unreadable, it SHALL exit 1 with a message naming the path. The flag is not `--env-file`, because Node takes that flag from anywhere in argv.

The `report` tool's description SHALL state that a submit requires a committed, clean worktree only when `ORCH_COMMIT_POLICY` is unset or `agent`.

A runner whose CLI can treat an MCP server as optional or gate its tools behind approvals SHALL register the façade as required and with its tools pre-approved. For Codex this means `required=true`, plus the default and per-tool `approve` keys.

#### Scenario: Daemon restart during a call
- **WHEN** the daemon is restarting while an agent calls the `report` tool
- **THEN** the façade retries until the daemon is back and the call succeeds within the retry window

#### Scenario: Report tool under daemon commits
- **WHEN** the façade starts with `ORCH_COMMIT_POLICY=daemon`
- **THEN** the `report` tool's description does not require a committed, clean worktree

#### Scenario: Env file
- **WHEN** the façade starts with `--orch-env-file` naming a file that holds the launch's variables, and none of them is in its environment
- **THEN** a `heartbeat` call is forwarded with the token from the file

#### Scenario: Env file missing
- **WHEN** the façade starts with `--orch-env-file` naming a file that does not exist
- **THEN** it exits 1 and stderr names the file

### Requirement: Brief validation and remediation
The brief template SHALL declare slots with a source, a `required` flag, and a minimum length, and the orchestrator SHALL validate a task against them when it becomes ready, or at ingest in strict mode. When validation fails, the configured policy SHALL either block the task with reason `insufficientSpec` listing the missing slots, or invoke the remediation hook to produce the missing content stored as a payload overlay keyed by graph revision. In `review` mode (default) the candidate SHALL land as `blocked` with kind `needsDecision` for a human to accept, edit, or reject; in `auto` mode it SHALL launch directly. v1 SHALL ship the hook interface with a default that blocks.

#### Scenario: Missing acceptance criteria blocks
- **WHEN** a ready task's payload has no acceptance criteria and the policy is `block`
- **THEN** the task is `blocked` with reason `insufficientSpec` listing `acceptanceCriteria`

#### Scenario: Review-mode candidate
- **WHEN** the policy is `remediate` in `review` mode and the hook returns a candidate
- **THEN** the task is `blocked` with kind `needsDecision` carrying the candidate, and unblock applies it to the payload overlay

### Requirement: Inbox notices for health
The inbox SHALL deliver notices of kind `stuck` with `idleMs` and a `message`, `nudge` with the operator's `message`, `baseMoved` with the new integration `head` and the `files` its commit touched, and `payloadChanged` with the new graph `rev`. The brief's workspace section SHALL state that such notices may arrive in the inbox, name the four kinds, and tell the agent to check `inbox` after long steps. The brief SHALL state that merging into, pushing to, or checking out the integration branch is not allowed. Under the `agent` commit policy it SHALL state that rebasing the launch branch onto the integration head is allowed. Under `daemon` it SHALL instead state that the orchestrator rebases the branch onto the integration head at verification.

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
When a task is relaunched after reopen, uncancel, or a cascade reset, its brief SHALL carry a `revision` context with `cause` of `reopened` or `upstreamReopened`, `upstream` naming the reopened task when the cause is `upstreamReopened`, `priorLaunchId`, `priorBranch`, and, when they exist, `priorPublishedSha` and `priorReportSummary`. The brief SHALL state that the prior published commit remains on the integration branch and is contained in `baseSha`, and SHALL instruct the agent to revise the prior work rather than redo it. The context SHALL be stored on the overlay entry at reset and cleared when the launch goes live, like other attempt context.

#### Scenario: Cascade dependent is briefed to revise
- **WHEN** T2 was published at sha P with summary S and is reset by a cascade reopen of T1
- **THEN** T2's next brief carries `revision` with cause `upstreamReopened`, upstream T1, `priorPublishedSha` P, and `priorReportSummary` S, and states that P is contained in the new `baseSha`

#### Scenario: Killed dependent is briefed with its branch
- **WHEN** T2 was running on branch `task/T2/l1` and is reset by a cascade
- **THEN** T2's next brief carries `revision` with `priorBranch` `task/T2/l1` and no `priorPublishedSha`

### Requirement: Proposals in the report
The submit report MAY carry `proposals`, a list of `{ title, description, acceptanceCriteria, deps?, scope?, labels? }` where `title`, `description`, and at least one acceptance criterion are required and every id in `deps` MUST name a node in the launch's graph revision. A report that violates this SHALL be answered 400 as malformed and the task SHALL stay `running`. `followUps` SHALL remain free text. When the report is accepted each proposal SHALL be stored as pending with id `<taskId>-p<n>`, where `n` counts the task's proposals from one, and the orchestrator SHALL NOT add any node to the graph on its own.

#### Scenario: Proposals stored pending
- **WHEN** T2's submit report carries two valid proposals
- **THEN** T2 is `submitted`, proposals `T2-p1` and `T2-p2` are pending, and the graph is unchanged

#### Scenario: Malformed proposal rejects the report
- **WHEN** a submit report carries a proposal with no acceptance criteria or with a dependency on an id the graph does not have
- **THEN** the response is 400 naming the proposal and the task is still `running`

### Requirement: Payload change notice
When a compatible reload changes the `payload` of a task whose status is `running` or `waiting`, the orchestrator SHALL append the notice `{ kind: 'payloadChanged', rev }` to its live launch's inbox, where `rev` is the new graph revision, unless `graph.payloadChangedNotice` is false. The launch's pinned brief and `graphRev` SHALL NOT change, and the next launch of the task SHALL compose its brief from the new payload. Dependency edits to started tasks SHALL remain incompatible.

#### Scenario: Notice delivered on the next inbox call
- **WHEN** the graph file changes T2's description while T2 is running and the reload is accepted at revision R
- **THEN** T2's next `inbox` call returns `{ kind: 'payloadChanged', rev: R }` and the brief in its worktree is unchanged

#### Scenario: Notice disabled by configuration
- **WHEN** `graph.payloadChangedNotice` is false and the same edit is reloaded
- **THEN** the inbox stays empty

#### Scenario: Next launch uses the new payload
- **WHEN** T2 fails after the notice and is relaunched
- **THEN** the new brief carries the edited description

### Requirement: Worker access
A worker that holds a claimed launch SHALL use the same five operations with the launch token, either directly against the loopback API or through the token-scoped operator tools, and SHALL be subject to the same scoping, deduplication, sealing, and fencing rules as a spawned agent. The per-launch MCP façade SHALL NOT be spawned for a claimed launch. The fallback file SHALL NOT be available to workers: the orchestrator reads `.orchestrator/report.json` only when it finds a launch's process dead, and a claimed launch has no process, so a worker that cannot reach the API SHALL keep retrying until the daemon answers or its lease expires. The brief SHALL be the same document for spawned and claimed launches, and the worker instructions SHALL override its fallback-file guidance.

#### Scenario: Worker submits through the operator server
- **WHEN** a worker commits in the worktree and calls `launch_report` with kind `submit` and its token
- **THEN** the submission is sealed and the task is `submitted` exactly as for a spawned agent

#### Scenario: Fallback file is not read for a claimed launch
- **WHEN** a worker writes `.orchestrator/report.json` with a submit and stops calling the API
- **THEN** the lease expires, the task is `failed` with reason `leaseExpired`, and the file is swept with the worktree

#### Scenario: Worker fenced after release
- **WHEN** a launch is released and its former worker calls `launch_heartbeat` with the old token
- **THEN** the response is 401 and nothing changes

### Requirement: Interrupted context in the brief
When a task is relaunched after a release with `keep`, its brief SHALL carry an `interrupted` context with `priorLaunchId`, `priorBranch`, `headSha`, `reason`, and `wipCommit` when uncommitted changes were preserved. The brief SHALL state that the previous launch was interrupted for that reason, that the branch holds its work so far at that head and that the work-in-progress commit, when present, holds changes the previous worker had not committed, and SHALL instruct the agent to continue from that branch by merging or cherry-picking it onto the new base, or to inspect it and start over, and to squash the work-in-progress commit before submitting. The context SHALL be stored on the overlay entry at the release and cleared when the next launch goes live, like other attempt context, and SHALL coexist with a question and answer when the release happened while `waiting`.

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
The brief's definition of done SHALL name the effective check command at the time the brief is composed. When `checkCommand` is unresolved the brief SHALL say that no check command is configured for the repository yet, that the operator is being asked, and that the agent must run the project's documented test suite before submitting. For spawned launches whose runner carries an allow list (the Claude Code runner), the brief's workspace section SHALL list the Bash rules in force, stating that a worker holding a claimed launch runs under its own permissions instead. It SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own. It SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it. For a `codex` launch the workspace section SHALL carry no Bash rules. It SHALL instead name the Codex sandbox mode and say that approvals are disabled, so a command the sandbox refuses fails with `Operation not permitted` and is not approved at runtime. It SHALL tell the agent not to retry such a command but to ask with a `needsAccess` question naming it. It SHALL also say that the operator can run the command or change `runner.codex.sandbox` for the next launch.

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

### Requirement: Agent environment
A launch the daemon spawns SHALL inherit the daemon's environment with these changes:
- `ORCH_HOME` replaced by a directory inside the run's data directory;
- `ORCH_URL`, `ORCH_REPO`, and `ORCH_DATA_DIR` removed;
- the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID`, and `ORCH_WORKTREE` added.

An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's. `ORCH_API` SHALL remain set so the shim reaches the agent's own daemon.

An MCP server that the agent's CLI spawns SHALL be assumed to receive only what the runner forwards to it explicitly. Codex passes the server a fixed set of variables plus its `env` entries. Both runners SHALL build the shim's variables through one `shimEnv` helper.

#### Scenario: Agent sees an isolated home
- **WHEN** a spawned agent's command writes `$ORCH_HOME` to a file
- **THEN** the path is inside the run's data directory, not the user's `~/.orchestrator`, and `ORCH_URL` is unset in the agent's environment

#### Scenario: Agent cannot list the user's runs
- **WHEN** a spawned agent runs `orchestrator-ctl runs`
- **THEN** the result lists no runs
