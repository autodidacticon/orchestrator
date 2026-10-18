## MODIFIED Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json`. They SHALL contain:
- the task payload verbatim and the acceptance criteria;
- the definition of done: under the `agent` commit policy, commit all work on the launch branch; under `daemon`, leave the work in the worktree for the orchestrator to commit at submit. In both cases: never merge or touch the integration branch, declare a no-op explicitly, and terminate after the report is accepted;
- workspace facts: worktree path, branch, `baseSha`, integration branch;
- the completion report of each direct dependency, and any released cancellation with its reason;
- attempt context when present: the prior failure report, verifier output, conflict details naming the files and the sibling that landed, and the human's answer;
- the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401.

The brief MUST be sufficient for a person to perform the task without any other channel.

#### Scenario: Brief carries direct dependency reports
- **WHEN** T2 is launched after T1 is done
- **THEN** T2's brief contains T1's completion report and nothing from transitive dependencies beyond a pointer to the log

#### Scenario: Retry brief carries context
- **WHEN** a task is launched for its second attempt after a verifier red check
- **THEN** the brief contains the first attempt's failure report and the check output

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
A stdio MCP server launched per agent SHALL expose the five operations as tools, forward them to the HTTP API with the token from its environment, and retry through daemon restarts for the retry window before surfacing an error. The `report` tool's description SHALL state that a submit requires a committed, clean worktree only when `ORCH_COMMIT_POLICY` is unset or `agent`.

#### Scenario: Daemon restart during a call
- **WHEN** the daemon is restarting while an agent calls the `report` tool
- **THEN** the façade retries until the daemon is back and the call succeeds within the retry window

#### Scenario: Report tool under daemon commits
- **WHEN** the façade starts with `ORCH_COMMIT_POLICY=daemon`
- **THEN** the `report` tool's description does not require a committed, clean worktree
