## MODIFIED Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;

The brief MUST be sufficient for a person to perform the task without any other channel.

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

#### Scenario: Remote brief names the clone and no daemon path
- **WHEN** a brief is composed for a remote launch on a run with `apiBaseUrl` `http://orchestrator.example:8080/`
- **THEN** its markdown names the branch, the base commit, the integration branch, `http://orchestrator.example:8080/v1/launches/<launchId>/...` and `.orchestrator/report.json`, and contains neither the run directory, the worktrees root, nor `127.0.0.1`

#### Scenario: Remote brief says to push before submitting
- **WHEN** a brief is composed for a remote launch
- **THEN** its Submit line tells the agent to commit all work on the branch, names the `orchestrator` MCP server's `report` tool as the one that pushes the branch to `origin` and names the pushed commit, tells an agent that calls the API itself to run `git push origin <branch>` first and send `sealedSha`, and says that the orchestrator reads the work from `origin`

#### Scenario: Remote brief after an interruption
- **WHEN** a brief is composed for a remote launch whose task's carry holds `interrupted` with `headSha` H
- **THEN** it says the branch starts at H, created there by the worker loop, not at the base commit

#### Scenario: Remote brief.json matches the markdown
- **WHEN** a brief is composed for a remote launch
- **THEN** its JSON carries the same `branch`, `baseSha`, `apiBaseUrl` and `fallbackPath` that the markdown names

#### Scenario: Remote brief in a repository with an openspec root
- **WHEN** a remote launch is prepared on a run whose clone contains `openspec/`
- **THEN** its brief carries the OpenSpec change-directory rule

### Requirement: Submission sealing
On `report submit` the orchestrator SHALL inspect the worktree, ignoring `.orchestrator/`. Under the launch's `agent` commit policy, a worktree with uncommitted or untracked changes SHALL be rejected with 409 and the list of files, and the task SHALL remain `running`. Once the worktree is clean or committed, the branch head SHALL be recorded as `sealedSha` and the task SHALL become `submitted`. Commits made after sealing SHALL be ignored by verification.

#### Scenario: Dirty worktree rejected
- **WHEN** an agent of a launch with the `agent` policy submits with an unstaged modification to `src/a.ts`
- **THEN** the response is 409 listing `src/a.ts` and the task is still `running`

#### Scenario: Dirty worktree committed by the daemon
- **WHEN** an agent of a launch with the `daemon` policy writes `T1.txt` and submits without committing
- **THEN** the response is 200, the launch branch head is a commit by `orchestrator` holding `T1.txt`, `sealedSha` is that head, and `agent.report` carries `committedByOrchestrator: true`

#### Scenario: Later commits ignored
- **WHEN** an agent submits at commit C1 and then commits C2 on the same branch
- **THEN** verification uses C1

#### Scenario: Remote submit without sealedSha
- **WHEN** the worker of a remote launch submits without `sealedSha`
- **THEN** the response is 400 naming `sealedSha`, no `agent.report` event is appended, and the task is still `running`

#### Scenario: Local submit ignores sealedSha
- **WHEN** an agent of a local launch commits C1 and submits with `sealedSha` set to any other value
- **THEN** the submission is sealed at C1 from the worktree and the task is `submitted`

### Requirement: Acceptance evidence
When the brief contains acceptance criteria, the submit report MUST include an `acceptance` entry with evidence for each criterion; otherwise the submission SHALL fail with reason `missingAcceptanceEvidence`. The check is structural; the orchestrator does not judge the evidence.

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
`block` SHALL persist the question, move the task to `waiting`, release its run slot, and hold the connection open until an answer is delivered or `maxWait` elapses. An operator answer SHALL be persisted before any resume. The task SHALL return to `running`, and the long-poll SHALL complete only after the scheduler admits it. When `maxWait` elapses, the task SHALL become `blocked` with the question preserved, and a later answer SHALL act as unblock-with-answer.

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
The brief and the MCP façade SHALL instruct the agent to retry the API with backoff for the retry window, and then to write `.orchestrator/report.json` and exit. The file SHALL carry `launchId`, `seq`, a kind of `submit`, `fail`, or `block`, and the body. Recovery SHALL apply the file when it finds the process dead. A fallback `block` SHALL be treated as a transition to `blocked` with the question.

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

The `report` tool's description SHALL state that a submit requires a committed, clean worktree only when `ORCH_COMMIT_POLICY` is unset or `agent`.

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

#### Scenario: Remote submit pushed and sealed by the façade
- **WHEN** the façade runs with `ORCH_ACCESS=remote`, `ORCH_WORKTREE` naming a clean clone whose one commit is not pushed and `ORCH_BRANCH` naming the launch branch, and the agent calls `report` with kind `submit` and no `sealedSha`
- **THEN** origin's launch branch is the clone's `HEAD`, the daemon records an `agent.report` event whose `sealedSha` is that sha, and the call is answered 200 with `accepted: true`

#### Scenario: Dirty clone refused without a round trip
- **WHEN** in remote mode the clone has a changed tracked file or an untracked file outside `.orchestrator/`, and the agent calls `report` with kind `submit`
- **THEN** the call is answered 409 `dirtyWorktree` naming the file, nothing is pushed, and the launch's `lastSignal` is still `claimed`; files under `.orchestrator/` alone leave the clone clean

#### Scenario: Failed push refused without a round trip
- **WHEN** in remote mode origin cannot be reached while the agent calls `report` with kind `submit`
- **THEN** the call is answered 503 `pushFailed` and the launch's `lastSignal` is still `claimed`; once origin is back, the same call with the same `seq` is accepted

#### Scenario: Remote mode without its variables
- **WHEN** the façade starts with `ORCH_ACCESS=remote` and no `ORCH_BRANCH`, or no `ORCH_WORKTREE`
- **THEN** it exits 1 and stderr names the missing variable

## ADDED Requirements

### Requirement: Standalone brief: definition of done
`brief.md` and `brief.json` SHALL contain:
- the definition of done: under the `agent` commit policy, commit all work on the launch branch (a dirty worktree is refused with the file list; commit and resubmit); under `daemon`, leave the changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted.

#### Scenario: Definition of done by commit policy
- **WHEN** a `claude-code` launch is briefed once under the `agent` commit policy and once under `daemon`
- **THEN** the `agent` brief tells the agent to commit all work on its branch and says uncommitted or untracked files are rejected with 409 and the file list, the `daemon` brief instead says the orchestrator commits what is uncommitted when it accepts the report, and both say never to merge into the integration branch, to declare a no-op with `noChanges`, and to terminate once the report is accepted

### Requirement: Standalone brief: OpenSpec change rule
When the repository has an `openspec/` root (the launch worktree contains `openspec/`), for every runner kind and commit policy the brief's definition of done SHALL also say to record any spec change as an OpenSpec change directory `openspec/changes/<name>/` named after the task, with `proposal.md`, `tasks.md` and `specs/<capability>/spec.md` delta files holding `## ADDED|MODIFIED|REMOVED Requirements` sections with full `### Requirement:` blocks, validated with `openspec validate <name>`.

#### Scenario: OpenSpec root detected in the worktree
- **WHEN** a brief is composed for a launch whose worktree has no `openspec/` directory, and again after `openspec/` is created in that worktree
- **THEN** the first brief has no change-directory rule and the second carries it in its Definition of done

### Requirement: Standalone brief: OpenSpec specs not edited directly
When the repository has an `openspec/` root (the launch worktree contains `openspec/`), for every runner kind and commit policy the brief's definition of done SHALL also say not to edit `openspec/specs/` directly.

#### Scenario: Rule against direct spec edits for every kind
- **WHEN** a `claude-code` brief under `agent`, a `codex` brief under `daemon` and an `opencode` brief under `allow` are composed for a repository with an `openspec/` root
- **THEN** each carries the change-directory rule, whose text says "Do not edit `openspec/specs/` directly"

### Requirement: Standalone brief: no OpenSpec rule without a root
Without an `openspec/` root the brief SHALL NOT carry the OpenSpec change-directory item of the definition of done.

#### Scenario: Golden briefs carry no OpenSpec rule
- **WHEN** a `claude-code`, `codex` or `opencode` brief is composed for a worktree without an `openspec/` root
- **THEN** the brief does not mention `openspec`

### Requirement: Standalone brief: attempt context
`brief.md` and `brief.json` SHALL contain:
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer.

#### Scenario: Answer carried into the next launch
- **WHEN** a task's question times out after `maxWait`, the task is `blocked`, and a human answers it
- **THEN** a new launch is made whose brief carries the question asked earlier and the human's answer

### Requirement: Standalone brief: attempt context by commit policy
Under `agent`, the conflict, interruption, and revision texts of the brief SHALL tell the agent to rebase, merge or cherry-pick the prior branch, squash a work-in-progress commit, and commit the delta. Under `daemon` they tell it instead to inspect the prior branch with `git show`/`git diff` and reapply the changes as file edits.

#### Scenario: Conflict, interruption and revision under each policy
- **WHEN** a launch is briefed with a carry holding a conflict on its previous branch, an interruption with a work-in-progress commit and a revision, once under the `agent` commit policy and once under `daemon`
- **THEN** the `agent` brief says to rebase that branch or start over, to squash the work-in-progress commit and to commit the delta, and the `daemon` brief says none of these and tells the agent to reapply the prior branch's changes as file edits

### Requirement: Standalone brief: reporting facts
`brief.md` and `brief.json` SHALL contain:
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

#### Scenario: Reporting section and brief.json
- **WHEN** a local launch is briefed
- **THEN** the Reporting section names the API at the launch's `/v1/launches/<launchId>/...` path, says to write the report to the fallback path when the API fails and to stop immediately when a call returns 401, and `brief.json` carries `apiBaseUrl`, `token` and `fallbackPath`

### Requirement: Standalone brief: remote brief names no daemon path
A remote launch (`access: remote`) has no worktree: its brief is kept on the launch row (see specs/remote-workspace). The text the orchestrator writes into a remote brief's workspace and reporting sections SHALL name no path on the daemon's machine (not the run directory, the worktrees root or the daemon's clone) and no loopback address; text carried verbatim (the payload, dependency reports, verifier output) is not rewritten.

#### Scenario: Remote brief kept on the launch row
- **WHEN** a remote launch is admitted
- **THEN** its row has `access` `remote`, an empty `worktree` and the brief's markdown and JSON, and neither the markdown nor the JSON contains the run directory or `127.0.0.1`

### Requirement: Standalone brief: remote workspace section
A remote brief's workspace section SHALL instead name the clone (the current directory, a clone of the repository the worker loop made), the branch, the base commit and the integration branch.

#### Scenario: Remote workspace lines
- **WHEN** a remote launch without an interrupted carry is briefed
- **THEN** its Workspace section has a `Clone:` line naming the current directory, a `Branch:` line saying the worker loop creates the branch at the base commit, `Base commit:` and `Integration branch:` lines and a `Submit:` line, and no `Worktree:` line

### Requirement: Standalone brief: remote submit line
A remote brief's workspace section SHALL say how work is submitted: commit all work on the branch; `report` with kind submit through the `orchestrator` MCP server's tool pushes the branch to `origin` and names the pushed commit; an agent that calls the API itself first runs `git push origin <branch>` and sends the tip's full sha as `sealedSha`; the orchestrator reads the work from `origin`, not from the clone.

#### Scenario: Remote submit line
- **WHEN** a remote launch is briefed
- **THEN** its `Submit:` line says to commit all work on the launch branch, that the `report` tool of the `orchestrator` MCP server called with kind submit pushes the branch to `origin` and names the pushed commit, that an agent calling the API itself first runs `git push origin <branch>` and sends the tip's full sha as `sealedSha`, and that the orchestrator reads the work from `origin`, not from the clone

### Requirement: Standalone brief: remote API base URL and fallback path
A remote brief's API base URL SHALL be `apiBaseUrl` (without a trailing slash), never the bind address, and its fallback report path SHALL be the relative path `.orchestrator/report.json`, which the brief says is relative to the root of the clone; `brief.json` SHALL carry the same branch, base commit, API base URL and fallback path.

#### Scenario: Trailing slash dropped
- **WHEN** a remote run's `apiBaseUrl` ends with `/` and a remote launch is briefed
- **THEN** the brief names the API as `apiBaseUrl` without the trailing slash followed by `/v1/launches/<launchId>/...`, says to write the report to `.orchestrator/report.json`, relative to the root of the clone, and `brief.json` has `apiBaseUrl` without the slash and `fallbackPath` `.orchestrator/report.json`

### Requirement: Standalone brief: remote brief after an interruption
For a carry holding `interrupted`, the remote brief SHALL say that the branch starts at `carry.interrupted.headSha` (the worker loop creates it there), not at the base commit, and SHALL NOT tell the agent to merge or cherry-pick the prior branch onto its base.

#### Scenario: Interrupted remote brief without the merge text
- **WHEN** a remote launch whose task's carry holds `interrupted` with a head sha and a work-in-progress commit is briefed
- **THEN** the `Branch:` line says the worker loop creates the branch at that head sha, the context says to squash the work-in-progress commit before submitting, the brief does not say to merge or cherry-pick the prior branch onto the base, and `brief.json`'s `context` carries the interrupted head sha

### Requirement: Standalone brief: remote definition of done
Whether the remote brief carries the OpenSpec change rule SHALL follow whether the daemon's clone has an `openspec/` root. The commit-policy lines of the definition of done SHALL be those of `agent`, since a remote launch never has policy `daemon`, and the prepare-command item SHALL NOT appear, since a remote run has no `prepareCommand`. A local launch's brief SHALL be unchanged by the rules of a remote brief.

#### Scenario: Remote run with a prepare command refused
- **WHEN** a configuration with `runner.access: remote` sets `prepareCommand`, or gives the default runner kind the `daemon` commit policy
- **THEN** the remote run is refused naming `prepareCommand must be unset` or the commit policy, so a remote brief never carries the prepare-command bullet or the `daemon` lines

#### Scenario: Local brief keeps the worktree text
- **WHEN** a launch without `access: remote` is briefed
- **THEN** the brief names the worktree and the absolute fallback path and has no `git push origin` line

### Requirement: Standalone brief: OpenCode reporting tools
The agent sees the shim's tools under a name that depends on its CLI: `mcp__orchestrator__<tool>` under Claude Code and Codex, `orchestrator_<tool>` under OpenCode. An `opencode` brief's Reporting section SHALL name `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log` and tell the agent to prefer them to calling the API from a command.

#### Scenario: OpenCode Reporting section names its tools
- **WHEN** an `opencode` launch is briefed
- **THEN** its Reporting section names `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox` and `orchestrator_log` and says to prefer them to calling the API from a command

### Requirement: Standalone brief: Reporting text by kind
The `claude-code` and `codex` briefs keep their Reporting text (the `codex` one is in "Codex brief reports through the MCP server"). An `opencode` brief's Reporting section SHALL keep the API and the fallback file, because no sandbox blocks loopback. An `opencode` brief's Reporting section SHALL NOT name `mcp__orchestrator__` tools.

#### Scenario: OpenCode brief keeps the API
- **WHEN** an `opencode` launch under `derived` is briefed
- **THEN** its Reporting section has the `API:` line and the fallback file line, it does not say "Do not call the API from a command", and the brief does not contain `mcp__orchestrator__`

### Requirement: Standalone brief: OpenCode permission rules
An `opencode` brief's workspace section SHALL say that OpenCode permission rules are in force with nothing else confining the agent's commands. An `opencode` brief's workspace section SHALL NOT mention a sandbox.

#### Scenario: Permission rules without a sandbox
- **WHEN** an `opencode` launch is briefed under `derived` or under `allow`
- **THEN** its Workspace section says it runs with OpenCode permission rules in force and nothing else confining its commands, and the brief does not contain the word sandbox

### Requirement: Standalone brief: OpenCode deny error
An `opencode` brief's workspace section SHALL say that a command a rule does not allow fails with "The user has specified a rule which prevents you from using this specific tool call." and is not approved at runtime. That is the `deny` error, which the model sees and continues past.

#### Scenario: Deny wording in the brief
- **WHEN** an `opencode` launch is briefed
- **THEN** its Workspace section says that a command a rule does not allow fails with 'The user has specified a rule which prevents you from using this specific tool call.' and will not be approved at runtime

### Requirement: Standalone brief: OpenCode needsAccess question
An `opencode` brief's workspace section SHALL tell the agent not to retry a command a rule does not allow but to ask with a `needsAccess` question naming the command and continue with what it can, and say that the operator can run it or set `runner.opencode.permission` to `allow` for the next launch.

#### Scenario: Ask instead of retrying
- **WHEN** an `opencode` launch is briefed
- **THEN** its Workspace section says not to retry a denied command, to ask with a `needsAccess` question naming the command and then continue with what it can, and that the operator can run it or set `runner.opencode.permission` to `allow` for the next launch

### Requirement: Standalone brief: OpenCode derived patterns
Under `derived` an `opencode` brief's workspace section SHALL list the file tools (read, glob, grep, list, edit, write), then the `bashPatterns` followed by the check command's patterns. An `opencode` brief's workspace section SHALL say that every other command is denied and that each command of a chain (`&&`, `;`, `|`) must match one of them on its own.

#### Scenario: Patterns in order
- **WHEN** an `opencode` launch under `derived` with `bashPatterns` `npm test *` and `git status` and the check command `npm test` is briefed
- **THEN** the brief lists the file tools (read, glob, grep, list, edit, write) and the bash commands `npm test *`, `git status`, `npm test` in that order, then says every other command is denied and each command of a chain must match one of them on its own

### Requirement: Standalone brief: runner in brief.json
`brief.json` SHALL carry the launch's `runner` (`kind`, `commitPolicy`, `sandbox` for a `codex` launch, and `permission` for an `opencode` launch). The `permission` holds `mode` (`derived` or `allow`) and, under `derived`, the `bashPatterns` the runner's ruleset allows, `git *` first.

#### Scenario: OpenCode runner in the brief input
- **WHEN** an `opencode` task is admitted under the default permission `derived`, and another under `runner.opencode.permission: allow`
- **THEN** the first brief's `runner` is `{ kind: opencode, commitPolicy: agent, permission: { mode: derived, bashPatterns } }` with `git *` first and no duplicate pattern, and the second's `permission` is `{ mode: allow }` with no patterns

### Requirement: Standalone brief: brief without a runner
A brief composed without a runner SHALL be the `claude-code` text under the `agent` policy.

#### Scenario: Same text as claude-code
- **WHEN** a brief is composed with the same input once with runner `{ kind: claude-code, commitPolicy: agent }` and once without a runner
- **THEN** the two markdown texts are equal

### Requirement: Submission sealing: daemon commit
Under `daemon`, the orchestrator SHALL commit a worktree's uncommitted or untracked changes on the launch branch: author and committer `orchestrator`, hooks skipped, the report summary as the message. The orchestrator SHALL then seal the new head, and the `agent.report` event SHALL carry `committedByOrchestrator: true`. Under either policy, a clean worktree SHALL NOT be committed.

#### Scenario: Daemon commit of an OpenCode submit
- **WHEN** an agent of an `opencode` launch under `runner.opencode.commit: daemon` leaves a file uncommitted and submits
- **THEN** the launch branch head is a commit authored and committed by `orchestrator` whose message is the report summary and which holds the file, the submission is sealed at that commit, the one `agent.report` event carries `committedByOrchestrator: true`, and the task reaches `done`

### Requirement: Submission sealing: remote launch
On a remote launch the daemon holds no worktree: the submit report SHALL carry `sealedSha`, the full object name of the launch branch tip the worker pushed to origin, and the orchestrator SHALL seal it as the `remote-workspace` capability's "Seal" requires instead of inspecting a tree; the commit policy does not apply. A remote submit without `sealedSha`, or with a value that is not a full hex object name, SHALL answer 400 naming `sealedSha` and record nothing.

#### Scenario: Malformed sealedSha
- **WHEN** the worker of a remote launch submits with a `sealedSha` that is not a full hex object name
- **THEN** the response is 400 naming `sealedSha`, no `agent.report` event is appended, and the task is still `running`

### Requirement: Submission sealing: local sealedSha ignored
On a local launch `sealedSha` in the report SHALL be ignored.

#### Scenario: Local seal reads the worktree
- **WHEN** the worker of a local launch commits on the launch branch and submits with `sealedSha` set to `not a sha`
- **THEN** the submit is not refused: it is accepted with outcome `submitted` and `sealedSha` the branch head read from the worktree

### Requirement: Submission sealing: refused seal records nothing
A refused seal, local or remote, SHALL record no `agent.report` event and no deduplicated response, so the same `seq` may be sent again.

#### Scenario: Same seq after a dirty refusal
- **WHEN** an agent submits a dirty worktree under the `agent` policy, is answered 409, commits, and submits again with the same `seq`
- **THEN** the task reaches `done` and one `agent.report` event is recorded

### Requirement: Acceptance evidence: criterion matching
An entry SHALL cover a criterion when its `criterion` matches the criterion's text after markdown code spans and emphasis, a leading list marker, and trailing punctuation are dropped, whitespace is collapsed, and case is ignored, or when it is the criterion's 1-based position in the brief's list.

#### Scenario: Numbered and loosely quoted entries
- **WHEN** the brief lists the criteria "works" and "documented" and the report's entries read "1. `Works`." and "2"
- **THEN** both criteria are covered and the submission is not failed for missing evidence

### Requirement: Block and wait: replay after a dropped connection
A dropped connection SHALL be recoverable by re-issuing `block` with the same `seq`, which returns the stored answer once admitted.

#### Scenario: Same seq after the answer
- **WHEN** an agent's `block` has been answered and the task admitted, and the agent calls `block` again with the same `seq`
- **THEN** the call returns the stored answer and one `agent.block` event is recorded

### Requirement: Block and wait: tool timeout above maxWait
A runner whose CLI times out MCP tool calls SHALL size that timeout above `maxWait`. The Codex runner's default is `ceil(maxWaitMs/1000)+60` seconds.

#### Scenario: Codex default tool timeout
- **WHEN** a Codex launch is composed with `maxWaitMs` 90 500 and no `runner.codex.toolTimeoutSec`
- **THEN** its command carries `tool_timeout_sec=151`

### Requirement: Fallback file: fallback submit sealed by commit policy
A fallback `submit` SHALL be sealed the way a posted one is under the launch's commit policy; under `daemon`, the `agent.fallback` event SHALL carry `committedByOrchestrator: true` when a commit was made.

#### Scenario: Daemon fallback submit records the commit
- **WHEN** an agent of a launch with the `daemon` policy leaves uncommitted changes, writes a `submit` fallback file with the summary `offline`, and its process dies
- **THEN** the orchestrator commits the changes with the message `offline`, the task reaches `done`, and the `agent.fallback` event carries `committedByOrchestrator: true`

### Requirement: MCP façade: env file
Started with `--orch-env-file <path>`, the façade SHALL layer the file's `KEY=VALUE` lines over its environment. When the file is missing or unreadable, the façade SHALL exit 1 with a message naming the path. The flag is not `--env-file`, because Node takes that flag from anywhere in argv.

#### Scenario: Codex registers the façade with its env file
- **WHEN** the Codex runner composes a launch's command
- **THEN** the `orchestrator` MCP server's args are the shim script, `--orch-env-file` and the launch's `.orchestrator/shim.env`, and the command line carries no launch token

### Requirement: MCP façade: remote mode
The façade SHALL be in remote mode when `ORCH_ACCESS` is `remote`; the worker loop starts it so for a remote launch (see specs/worker-pool "Clone cache"). The façade in remote mode then SHALL need `ORCH_WORKTREE` (the clone's path) and `ORCH_BRANCH` (the launch branch), and without either it SHALL exit 1 with a message naming the missing variable.

#### Scenario: Remote mode needs both variables
- **WHEN** the façade starts with `ORCH_ACCESS=remote` and `ORCH_WORKTREE` but no `ORCH_BRANCH`, and again with `ORCH_BRANCH` but no `ORCH_WORKTREE`
- **THEN** each start exits 1 and stderr names the variable that is missing

### Requirement: MCP façade: other access values
With any other `ORCH_ACCESS` the façade SHALL read neither variable and behave as without remote mode, since a spawned agent's environment carries `ORCH_WORKTREE` too.

#### Scenario: ORCH_WORKTREE alone changes nothing
- **WHEN** the façade starts with no `ORCH_ACCESS`, with `ORCH_WORKTREE` alone, or with `ORCH_ACCESS=local` and `ORCH_WORKTREE`
- **THEN** its `report` tool has the description of a local façade

### Requirement: MCP façade: remote submit dirty check
In remote mode a `report` call with kind `submit` SHALL do three things before it calls the daemon, and the daemon's answer SHALL be returned unchanged; the first SHALL be:
- the dirty check of the clone by the rule of a local seal (changed and untracked paths outside `.orchestrator/`): a dirty clone is answered `{ status: 409, error: "dirtyWorktree", files }`;

#### Scenario: Untracked file refused
- **WHEN** in remote mode the clone has an untracked file outside `.orchestrator/` and the agent calls `report` with kind `submit`
- **THEN** the call is answered 409 `dirtyWorktree` with that file in `files`, and no `agent.report` event is recorded

### Requirement: MCP façade: remote submit push
In remote mode a `report` call with kind `submit` SHALL do three things before it calls the daemon; the second SHALL be:
- `git push --force origin HEAD:refs/heads/<ORCH_BRANCH>`, without a prompt and killed after 60 seconds: a failed push is answered `{ status: 503, error: "pushFailed", message }`. The push is forced because the launch branch belongs to the launch alone and an agent may rebase it after a `baseMoved` notice; `HEAD` is pushed whatever branch the clone has checked out;

#### Scenario: Rewritten branch pushed with force
- **WHEN** in remote mode origin's launch branch holds commit A, the agent amends A into A2 in its clone, and calls `report` with kind `submit`
- **THEN** the façade's forced push makes A2 origin's launch branch tip, and the submit is accepted with one `agent.report` event whose `sealedSha` is A2

### Requirement: MCP façade: remote submit names the pushed tip
In remote mode a `report` call with kind `submit` SHALL do three things before it calls the daemon; the third SHALL be:
- the full sha of `HEAD`, added to the body as `sealedSha`.

The `report` tool's input schema SHALL NOT declare `sealedSha`: the façade always names the tip it pushed.

#### Scenario: Pushed HEAD forwarded as sealedSha
- **WHEN** in remote mode the agent calls `report` with kind `submit` on a clean clone whose push succeeds
- **THEN** the daemon's `agent.report` event carries `sealedSha` equal to the clone's `HEAD`, though the tool's input had no such field

### Requirement: MCP façade: remote refusals
A git command that fails in the dirty check or while reading `HEAD` SHALL be answered `{ status: 500, error: "gitFailed", message }`. After any of the `dirtyWorktree`, `pushFailed` and `gitFailed` refusals nothing is sent to the daemon, so the same call may be sent again with the same `seq`.

#### Scenario: Git failure without a round trip
- **WHEN** in remote mode `ORCH_WORKTREE` names a directory that is not a git repository and the agent calls `report` with kind `submit`
- **THEN** the call is answered 500 `gitFailed` with a message naming git, the launch's `lastSignal` is still `claimed`, and the daemon records no `agent.report` event

### Requirement: MCP façade: remote mode forwards other calls
A `report` with kind `fail` and the other four tools SHALL be forwarded as without remote mode.

#### Scenario: Fail report in remote mode
- **WHEN** in remote mode the agent calls `report` with kind `fail`
- **THEN** nothing is pushed to origin and the daemon's `agent.report` event has no `sealedSha`

### Requirement: MCP façade: remote report description and help
In remote mode the `report` tool's description SHALL say that a submit needs committed work, that the tool pushes the branch to `origin` and names its tip, and that after a 409 or 503 answer the same call may be sent again with the same `seq`. The `--help` text SHALL name `ORCH_ACCESS`, `ORCH_WORKTREE` and `ORCH_BRANCH`.

#### Scenario: Remote description and help text
- **WHEN** the façade starts in remote mode and is listed, and is run with `--help`
- **THEN** the `report` tool's description mentions `origin` and the same `seq`, and the help text names `ORCH_ACCESS`, `ORCH_WORKTREE` and `ORCH_BRANCH`

### Requirement: MCP façade: required and pre-approved registration
A runner whose CLI can treat an MCP server as optional or gate its tools behind approvals SHALL register the façade as required and with its tools pre-approved. For Codex this means `required=true`, plus the default and per-tool `approve` keys. OpenCode has no `required` analog (a server that cannot start is a warning and the run continues); its tools are named `orchestrator_<tool>` and are pre-approved by the permission rule `"orchestrator_*": "allow"`.

#### Scenario: Codex and OpenCode registrations
- **WHEN** the Codex runner composes a launch's command and the OpenCode runner builds a launch's config
- **THEN** the Codex command carries `mcp_servers.orchestrator.required=true`, the default tools approval mode `approve` and an `approve` approval mode for each of the five tools, and the OpenCode permission rules carry `"orchestrator_*": "allow"`

### Requirement: MCP façade: tool timeout above maxWaitMs
A runner whose CLI times out MCP calls SHALL size the tool timeout above `maxWaitMs`, so a `block` long-poll is not cut: Codex through `tool_timeout_sec`, OpenCode through `mcp.orchestrator.timeout` (its default is 60 000 ms).

#### Scenario: OpenCode timeout above maxWaitMs
- **WHEN** the OpenCode runner builds a launch's config with `maxWaitMs` 90 500 and no `toolTimeoutMs`
- **THEN** `mcp.orchestrator.timeout` is 150 500, and with `toolTimeoutMs` 120 000 it is 120 000
