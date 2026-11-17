# Agent Protocol Specification

## Purpose
What an agent receives and how it reports back: the standalone brief, launch token scoping, deduplicated events, sealed submissions, declared no-ops, acceptance evidence, blocking and resume, the file fallback, the MCP façade, brief validation, the inbox notices of kind `stuck`, `nudge`, and `baseMoved` through which the daemon and the operator reach a running agent, the `payloadChanged` notice that tells a live agent its task's payload changed on reload, the revision context a brief carries after a reopen or a cascade reset so that the agent revises its prior work rather than redoing it, the proposals a submit report may carry for follow-up work, which the orchestrator stores pending and never adds to the graph on its own, and the worker access rules under which a worker holding a claimed launch acts as the agent through the same five operations with the launch token, directly against the loopback API or through the token-scoped operator tools, with no per-launch façade and no fallback file.
## Requirements
### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted. When the repository has an `openspec/` root (the launch worktree contains `openspec/`), for every runner kind and commit policy it SHALL also say to record any spec change as an OpenSpec change directory `openspec/changes/<name>/` named after the task, with `proposal.md`, `tasks.md` and `specs/<capability>/spec.md` delta files holding `## ADDED|MODIFIED|REMOVED Requirements` sections with full `### Requirement:` blocks, validated with `openspec validate <name>`, and not to edit `openspec/specs/` directly. Without an `openspec/` root the brief SHALL NOT carry that item;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer. Under `agent`, the conflict, interruption, and revision texts tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta. Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits;
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

The agent sees the shim's tools under a name that depends on its CLI: `mcp__orchestrator__<tool>` under Claude Code and Codex, `orchestrator_<tool>` under OpenCode. The `claude-code` and `codex` briefs keep their Reporting text (the `codex` one is in "Codex brief reports through the MCP server"). An `opencode` brief's Reporting section SHALL name `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log` and tell the agent to prefer them to calling the API from a command. It SHALL keep the API and the fallback file, because no sandbox blocks loopback. It SHALL NOT name `mcp__orchestrator__` tools.

An `opencode` brief's workspace section SHALL say that OpenCode permission rules are in force with nothing else confining the agent's commands. It SHALL say that a command a rule does not allow fails with "The user has specified a rule which prevents you from using this specific tool call." and is not approved at runtime. That is the `deny` error, which the model sees and continues past. It SHALL tell the agent not to retry it but to ask with a `needsAccess` question naming the command and continue with what it can, and say that the operator can run it or set `runner.opencode.permission` to `allow` for the next launch. Under `derived` it SHALL list the file tools (read, glob, grep, list, edit, write), then the `bashPatterns` followed by the check command's patterns. It SHALL say that every other command is denied and that each command of a chain (`&&`, `;`, `|`) must match one of them on its own. It SHALL NOT mention a sandbox.

`brief.json` SHALL carry the launch's `runner` (`kind`, `commitPolicy`, `sandbox` for a `codex` launch, and `permission` for an `opencode` launch). The `permission` holds `mode` (`derived` or `allow`) and, under `derived`, the `bashPatterns` the runner's ruleset allows, `git *` first. A brief composed without a runner SHALL be the `claude-code` text under the `agent` policy. The brief MUST be sufficient for a person to perform the task without any other channel.

#### Scenario: Brief carries direct dependency reports
- **WHEN** T2 is launched after T1 is done
- **THEN** T2's brief contains T1's completion report and nothing from transitive dependencies beyond a pointer to the log

#### Scenario: Retry brief carries context
- **WHEN** a task is launched for its second attempt after a verifier red check
- **THEN** the brief contains the first attempt's failure report and the check output

#### Scenario: Codex brief under daemon commits
- **WHEN** a brief is composed for a `codex` launch with `commitPolicy: daemon`, carrying interruption (with a work-in-progress commit), conflict, and revision context
- **THEN** it says the orchestrator commits uncommitted changes, tells the agent to reapply the prior branch's changes as file edits, does not contain "commit and resubmit", "squash the work-in-progress commit", or "commit the delta", and `brief.json` carries `runner.kind: codex`

#### Scenario: OpenCode brief names its tools and the deny error
- **WHEN** a brief is composed for an `opencode` launch
- **THEN** it names `orchestrator_report` and the other four tools, contains "The user has specified a rule which prevents you" and not "The user rejected permission", keeps the API line, and contains neither "sandbox" nor `mcp__orchestrator__`

#### Scenario: Claude Code and Codex briefs unchanged by the third kind
- **WHEN** the briefs of a `claude-code` and a `codex` launch are composed from the inputs of the goldens in `test/fixtures/brief`
- **THEN** each is byte-identical to its golden

#### Scenario: Brief in a repository with an openspec root carries the change-directory rule
- **WHEN** a brief is composed for a launch whose worktree contains `openspec/`
- **THEN** its Definition of done says to record spec changes as an OpenSpec change directory `openspec/changes/<name>/` validated with `openspec validate <name>` and not to edit `openspec/specs/` directly, and the `claude-code` brief is byte-identical to the golden `test/fixtures/brief/claude-code-openspec.md`

#### Scenario: Brief without an openspec root has no change-directory rule
- **WHEN** a brief is composed for a launch whose worktree has no `openspec/`
- **THEN** its Definition of done does not mention OpenSpec

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

A runner whose CLI can treat an MCP server as optional or gate its tools behind approvals SHALL register the façade as required and with its tools pre-approved. For Codex this means `required=true`, plus the default and per-tool `approve` keys. OpenCode has no `required` analog (a server that cannot start is a warning and the run continues); its tools are named `orchestrator_<tool>` and are pre-approved by the permission rule `"orchestrator_*": "allow"`.

A runner whose CLI times out MCP calls SHALL size the tool timeout above `maxWaitMs`, so a `block` long-poll is not cut: Codex through `tool_timeout_sec`, OpenCode through `mcp.orchestrator.timeout` (its default is 60 000 ms).

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
A worker that holds a claimed launch SHALL use the same five operations with the launch token, either directly against the loopback API or through the token-scoped operator tools, and SHALL be subject to the same scoping, deduplication, sealing, and fencing rules as a spawned agent. The daemon SHALL NOT spawn the per-launch MCP façade for a claimed launch. A worker loop that runs the agent as its own process, such as the Codex work loop, MAY register the façade for that process the way the runner of that kind registers it for a spawned launch, with the launch's identity in the same env file, so that the agent sees the same tool names. The fallback file SHALL NOT be available to workers: the orchestrator reads `.orchestrator/report.json` only when it finds a launch's process dead, and a claimed launch has no process the daemon watches, so a worker that cannot reach the API SHALL keep retrying until the daemon answers or its lease expires. The brief SHALL be the same document for spawned and claimed launches, and the worker instructions SHALL override its fallback-file guidance.

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
The brief's definition of done SHALL name the effective check command at the time the brief is composed. When `checkCommand` is unresolved the brief SHALL say that no check command is configured for the repository yet, that the operator is being asked, and that the agent must run the project's documented test suite before submitting. For spawned launches whose runner carries an allow list (the Claude Code runner), the brief's workspace section SHALL list the Bash rules in force, stating that a worker holding a claimed launch runs under its own permissions instead. It SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own. It SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it. For a `codex` launch the workspace section SHALL carry no Bash rules. It SHALL instead name the Codex sandbox mode and say that approvals are disabled, so a command the sandbox refuses fails with `Operation not permitted` and is not approved at runtime. It SHALL tell the agent not to retry such a command but to ask with a `needsAccess` question naming it. It SHALL also say that the operator can run the command or change `runner.codex.sandbox` for the next launch. For an `opencode` launch the workspace section SHALL carry no Bash rules either. Under `runner.opencode.permission: derived` it SHALL list the bash patterns the runner's ruleset allows (`git *` and the patterns derived from the same rules the OpenCode runner is given: `Bash(x:*)` as `x *`, `Bash(x)` as `x`), next to the file tools and the orchestrator tools, and say every other command is rejected. Under `allow` it SHALL say every command and tool is allowed and list no patterns. Both forms SHALL state that a worker holding a claimed launch runs under its own permissions instead. A retry brief's runner diagnosis line SHALL name permission rules rather than a sandbox among the causes outside the worktree.

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
- while the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS`, and every variable whose value is the resolved store URL removed (specs/state-backend "No store URL in child environments"), for every runner kind. While it does not withhold (a SQLite store with no Postgres input), they are passed unchanged;
- the agent variables `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID`, and `ORCH_WORKTREE` added.

The `env` block of a codex or opencode claim SHALL carry the same changes. A removed name appears there as an empty value, which the work loop deletes. A name that is passed does not appear there at all, so the worker's own value stays.

An orchestrator client the agent runs therefore SHALL find no run under its `ORCH_HOME` and SHALL NOT be able to start, stop, or list a daemon of the user's. `ORCH_API` SHALL remain set so the shim reaches the agent's own daemon. What a spawned agent running as the daemon's user can still reach of the store's credentials is stated in specs/state-backend "Store credentials a child can still reach".

An MCP server that the agent's CLI spawns SHALL be assumed to receive only what the runner forwards to it explicitly, unless the CLI is known to pass its whole environment on. Codex passes the server a fixed set of variables plus its `env` entries. OpenCode passes the MCP child its whole environment plus the server's `environment`, so the OpenCode runner SHALL forward nothing: it puts the shim's variables in the agent environment, registers the server with no `environment` block, and keeps the token off argv and out of every file. The runners SHALL build the shim's variables through one `shimEnv` helper.

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

### Requirement: Codex brief reports through the MCP server
The brief of a `codex` launch SHALL tell the agent to call heartbeat, report, block, inbox and log through the `orchestrator` MCP server's tools, and not to call the agent API from a command (curl or a script), because the Codex sandbox refuses a command's network access while Codex runs the MCP server outside the sandbox. It SHALL keep the fallback report file for the case where an MCP tool call itself fails. A `claude-code` or `opencode` brief SHALL NOT carry this text.

#### Scenario: Codex brief names the MCP tools
- **WHEN** a brief is composed for a `codex` launch
- **THEN** its Reporting section names the `orchestrator` MCP server's tools and says not to call the API from a command

#### Scenario: Real Codex reports through the MCP server
- **WHEN** the opt-in e2e (`ORCH_E2E_CODEX=1`) runs four tasks under `workspace-write`
- **THEN** every task is published through an MCP `report`, no launch ends with `fallback:submit`, and the question task's log holds exactly one completed `block` item carrying the answer

### Requirement: Heartbeat interval
When the brief input carries the lease TTL, which the daemon passes from its `leaseTtlMs`, the brief's Reporting section SHALL carry a lease line and `brief.json` SHALL carry `leaseTtlMs`. The line SHALL state the TTL. It SHALL say to call an operation at least every third of the TTL, naming `lease.renewEveryMs` and its value. It SHALL say to run any longer command in the background and call `heartbeat` while it runs.

#### Scenario: Brief names the interval
- **WHEN** a launch is prepared under `leaseTtlMs: 60000`
- **THEN** `brief.json` has `leaseTtlMs: 60000` and `brief.md` says to call at least every 20s (`lease.renewEveryMs` 20000, a third of the lease) and to run longer commands in the background while calling `heartbeat`

### Requirement: No lease line without a TTL
A brief composed from an input without `leaseTtlMs` SHALL carry no lease line, and its `brief.json` no `leaseTtlMs`.

#### Scenario: No TTL, no line
- **WHEN** a brief is composed from an input without `leaseTtlMs`
- **THEN** the brief has no lease line and `brief.json` has no `leaseTtlMs`

### Requirement: Integer fields
The `log`, `heartbeat`, `report` and `block` calls SHALL check `seq`, when it is present, before anything is written; the lease renewal and the progress signal count as writes. `seq` SHALL be a non-negative safe integer. Otherwise the call SHALL answer 400 with `field: "seq"` and an error that names `seq`. The worker `usage` call SHALL require its token counts to be non-negative safe integers, and SHALL answer 400 naming the field before it records anything.

#### Scenario: Fractional seq
- **WHEN** an agent calls `log` with `"seq": 1.5`
- **THEN** the call answers 400 naming `seq`, and no event, dedup row or lease renewal is written

#### Scenario: Huge seq
- **WHEN** an agent calls `log` with `"seq": 1e30`
- **THEN** the call answers 400 naming `seq`, and nothing is written

### Requirement: Unstorable values answer 400
A write the store refuses with `UnstorableValueError` SHALL answer 400 with the error and its `field`, on agent and operator routes alike. A string the store cannot hold as it is SHALL NOT cause an error: it is stored with U+FFFD in place (see state-backend "Storable strings").

#### Scenario: NUL in a log text
- **WHEN** an agent calls `log` with `"text": "a\u0000b"`
- **THEN** the call answers 200 and the event holds `a�b`

#### Scenario: Store refusal over HTTP
- **WHEN** a route's write binds a non-integer to an integer column
- **THEN** the HTTP response is 400, with `field` naming `table.column`, and not 500

### Requirement: No lease line for a spawned launch
The daemon SHALL pass `leaseTtlMs` in the brief input only for a launch prepared for a claim, so that only such a brief carries the lease line. A launch prepared in `spawn` mode SHALL get no lease line: the tick renews a spawned launch's lease while its process lives.

#### Scenario: Spawn mode
- **WHEN** a launch is prepared and spawned in `spawn` mode
- **THEN** its brief input has no `leaseTtlMs` and its brief has no lease line

### Requirement: Expiry rule in the lease line
The brief's lease line SHALL say that a lease expiry keeps the worker's commits, changes to tracked files and staged files on its branch, and that a new file it has not staged is not kept.

#### Scenario: Lease line names the staging rule
- **WHEN** a launch is prepared for a claim
- **THEN** its lease line says that an unstaged new file is not kept at expiry

### Requirement: Parked launch rebriefed before it is spawned
A parked launch that the daemon spawns once its claim window elapses SHALL leave `claimable` before anything else is done, so no claim can take it. Its worktree and brief SHALL then be prepared again, without the lease line, before its process starts. The new brief is composed from the configuration in force at that moment; this is an exception to the rule that a launch already briefed keeps its text, because the launch is prepared again.

#### Scenario: Parked, then spawned
- **WHEN** in `mixed` mode a parked launch, briefed with the lease line, is spawned after `claimWindowMs`
- **THEN** the spawned launch's brief has no lease line and `brief.json` no `leaseTtlMs`

### Requirement: Durable inbox
`GET /v1/launches/:id/inbox` renews the lease, records a progress signal and removes the notices it hands out, so it SHALL answer only once those writes are durable, like a POST. It SHALL hand out only notices whose records are durable. When the store goes fatal during the wait, the read SHALL NOT answer with notices.

#### Scenario: Notice queued during a stall
- **WHEN** the sink stalls, a nudge is queued, and the agent reads its inbox
- **THEN** the read does not answer until the sink accepts the nudge's record, and then answers with the nudge

#### Scenario: Durable notice, stalled inbox write
- **WHEN** a nudge is durable, the sink then stalls, and the agent reads its inbox
- **THEN** the read does not answer until its own writes are durable

### Requirement: Inbox notices handed out once
An inbox read SHALL take the notices the launch holds, wait until everything committed so far is durable, remove only the notices it took, and wait for that removal to be durable. A notice queued during the wait SHALL stay for the next read. Inbox reads of one launch SHALL run one at a time, so each notice is handed out once. A notice SHALL be removed from the launch only when its answer goes to a caller whose connection is still open. When the caller is gone after the first wait, the read SHALL remove nothing. When the caller is gone after the removal's wait, the read SHALL put the removed notices back at the front of the launch's notices, ahead of any queued meanwhile. Either way the next read SHALL hand them out.

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

### Requirement: Brief states the limits in force
The daemon SHALL pass in every brief input it builds `limits` (`stuckAfterMs`, `stuckFailAfterMs`, `maxLaunchMs`) from the configuration in force when the brief is composed, and `brief.json` SHALL carry it. The Reporting section SHALL hold one `- Limits:` line after the place of the lease line stating each limit above 0 with its consequence, what counts as progress, what to do, and that the numbers can change during the run, a change arriving as a `nudge` notice.

#### Scenario: Default limits
- **WHEN** a launch is briefed under the default configuration
- **THEN** its brief has one limits line naming `health.stuckAfterMs` 900000 (flagged, a `stuck` notice in the inbox), `health.stuckFailAfterMs` 2700000 (the launch is ended and the attempt spent) and `budgets.maxLaunchMs` 7200000 (the launch is ended when the budget is used up, also while it makes progress)
- **AND** the line says a progress signal is a call to an operation, a commit, or a change in the worktree, tells the worker to call `heartbeat` between long steps, to run a longer command in the background, and to report or ask a question before the budget ends
- **AND** the line says the numbers are those in force when the brief was written, that the operator can change them during the run, and that a change arrives as a `nudge` notice in the inbox
- **AND** the line does not say when the budget clock starts, what it leaves out, or how idle time is measured, and holds no URL
- **AND** `brief.json` carries `limits` with those three numbers

#### Scenario: One limit 0
- **WHEN** a brief is composed with `stuckAfterMs` 0 and the other two limits above 0
- **THEN** the limits line does not name `health.stuckAfterMs` or promise a `stuck` notice, and still names the other two limits

#### Scenario: All limits 0
- **WHEN** a brief is composed with all three limits 0
- **THEN** the brief has no limits line, and `brief.json` carries `limits` with the three zeros

#### Scenario: Input without limits
- **WHEN** a brief is composed from an input without `limits`
- **THEN** the brief has no limits line and `brief.json` has no `limits` key

#### Scenario: Launch prepared for a claim
- **WHEN** a launch is prepared for a claim
- **THEN** its brief has the lease line followed by the limits line, and `brief.json` carries both `leaseTtlMs` and `limits`

### Requirement: Codex brief states the network limit
As an exception to the `needsAccess` rule of "Check command and tool rules in the brief", a `codex` brief whose sandbox lacks network SHALL tell the worker to run the parts of the check that work, submit without asking, and name in the report summary what did not run; a login, a credential or a token SHALL stay a `needsAccess` question. The bullet SHALL follow the configuration in force when the brief was composed, so a launch parked before a change and claimed after it keeps it.

#### Scenario: Network access in the brief input
- **WHEN** the daemon builds the brief input of a `codex` launch
- **THEN** its `runner` carries `networkAccess`: true under `runner.codex.sandbox: danger-full-access`, true under `workspace-write` when `runner.codex.networkAccess` is true, false under `read-only` or under `workspace-write` with the key unset or false, whatever the text of a custom `runner.codex.command`
- **AND** the brief input of a launch of another kind carries no `networkAccess` key

#### Scenario: No network access
- **WHEN** a `codex` launch with `networkAccess` false is briefed with check command `npm ci && npm test`
- **THEN** its Definition of done holds, after the check command bullet, one bullet saying the commands have no network access, so an install that must download fails and a test that opens a port or a local socket can fail, and that an install can be refused for writing to a package store outside the worktree
- **AND** the bullet says the orchestrator runs the check command itself, outside the sandbox, after the submit; that the worker runs the parts that do run and, for the rest, does not ask with a `needsAccess` question and does not wait but submits and names in the report summary each part that did not run and its error
- **AND** the bullet says it is the exception to the `needsAccess` rule under Workspace and that a login, a credential or a token stays a `needsAccess` question
- **AND** the check command bullet and the sandbox paragraph, with its pointer to `runner.codex.sandbox`, are unchanged
- **AND** `brief.json` carries `runner.networkAccess` false

#### Scenario: Network access granted under workspace-write
- **WHEN** a `codex` launch under `workspace-write` with `networkAccess` true is briefed with a check command
- **THEN** its Definition of done holds one bullet saying `runner.codex.networkAccess` is on but a test that opens a port or a local socket, and an install that writes to a package store outside the worktree, may still be refused, with the same submit rule and the same login and credential exception
- **AND** the brief neither says the commands have no network access nor that they have network access

#### Scenario: Danger-full-access
- **WHEN** a `codex` launch under `danger-full-access` with `networkAccess` true is briefed
- **THEN** the brief holds neither bullet

#### Scenario: No networkAccess field
- **WHEN** a brief is composed from an input whose `runner` has no `networkAccess`
- **THEN** the brief and `brief.json` are byte for byte what they were before this requirement

#### Scenario: No check command
- **WHEN** a `codex` launch with `networkAccess` false, or true under `workspace-write`, is briefed with no check command configured
- **THEN** the bullet speaks of the project's test suite in place of the check and does not say the orchestrator runs a check after the submit

#### Scenario: Another kind
- **WHEN** a brief input of a `claude-code` or `opencode` launch is composed, even one carrying `networkAccess`
- **THEN** the brief holds neither bullet

#### Scenario: Parked launch claimed after a change
- **WHEN** a launch parked under one value of `runner.codex.sandbox` or `runner.codex.networkAccess` is claimed after the operator changes it
- **THEN** the worker gets the brief composed when the launch was prepared, with its bullet unchanged

### Requirement: Limit change notice
When an accepted configuration patch changes the value in force of `budgets.maxLaunchMs`, `health.stuckAfterMs` or `health.stuckFailAfterMs`, the daemon SHALL queue one inbox notice to each affected launch: `{ kind: 'nudge', source: 'config', message, changed, limits }`. `changed` SHALL list the dotted names of the limits whose value in force changed. `limits` SHALL hold the three values now in force, nested like the config file: `{ budgets: { maxLaunchMs }, health: { stuckAfterMs, stuckFailAfterMs } }`. `message` SHALL state, for each changed limit, the old and the new value in milliseconds, SHALL say that 0 means the limit is off, and for the time budget SHALL give the launch's elapsed time, with time the daemon did not run left out as at the time budget check. The affected launches SHALL be every launch with status `live` or `launching` that holds the lease of a `running` or `waiting` task, and every launch with status `claimable`. The notices SHALL be queued in the store transaction that writes the override document, each with its `launch.notice` event; no other operator event SHALL be appended. A patch that changes no value in force of the three limits, a patch of any other key, and a refused patch SHALL queue nothing. The notice SHALL be delivered once, like any notice, and nothing in the daemon SHALL depend on it being read.

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

### Requirement: Prepare command in the brief
The brief of a launch prepared while `prepareCommand` is set SHALL carry, in "Definition of done" directly after the check command bullet, the bullet `` - Dependencies are installed: the orchestrator ran `<prepareCommand>` in this worktree before you started, outside any sandbox. Do not run it again unless your change needs it. ``, and `brief.json` SHALL carry `prepareCommand`. Both SHALL be absent when the key is unset. The command's output SHALL never be in the brief.

#### Scenario: Bullet after the check command bullet
- **WHEN** a brief is composed with `prepareCommand: "npm ci"`
- **THEN** the line after the check command bullet is the prepare bullet naming `npm ci`, and `brief.json` has `prepareCommand: "npm ci"`

#### Scenario: Order beside the Codex network bullet
- **WHEN** a Codex launch without network access is prepared with a prepare command
- **THEN** the check command bullet, the prepare bullet and the network bullet appear in that order

#### Scenario: Every runner kind and mode
- **WHEN** a launch of any runner kind is prepared in `spawn`, `pull` or `mixed` mode with the key set
- **THEN** its brief carries the bullet

#### Scenario: Key unset
- **WHEN** `prepareCommand` is unset
- **THEN** the brief has no such bullet, `brief.json` has no `prepareCommand`, and the golden briefs are unchanged

