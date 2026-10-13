# Agent Protocol Specification

## Purpose
What an agent receives and how it reports back: the standalone brief, launch token scoping, deduplicated events, sealed submissions, declared no-ops, acceptance evidence, blocking and resume, the file fallback, the MCP façade, brief validation, and the inbox notices of kind `stuck`, `nudge`, and `baseMoved` through which the daemon and the operator reach a running agent.

## Requirements

### Requirement: Standalone brief
Before launching, the orchestrator SHALL write `<worktree>/.orchestrator/brief.md` and `brief.json` containing: the task payload verbatim; the acceptance criteria; the definition of done (commit all work on the launch branch, never merge or touch the integration branch, declare a no-op explicitly, terminate after the report is accepted); workspace facts (worktree path, branch, `baseSha`, integration branch); the completion report of each direct dependency and any released cancellation with its reason; attempt context when present (prior failure report, verifier output, conflict details naming the files and the sibling that landed, the human's answer); the API base URL, the launch token, the fallback report path, and the instruction to stop immediately on a 401. The brief MUST be sufficient for a person to perform the task without any other channel.

#### Scenario: Brief carries direct dependency reports
- **WHEN** T2 is launched after T1 is done
- **THEN** T2's brief contains T1's completion report and nothing from transitive dependencies beyond a pointer to the log

#### Scenario: Retry brief carries context
- **WHEN** a task is launched for its second attempt after a verifier red check
- **THEN** the brief contains the first attempt's failure report and the check output

### Requirement: Launch token scoping
Every API call SHALL carry a bearer token issued for one launch. A call whose token does not match the launch in the path, or whose launch has been revoked or ended, SHALL be answered with 401 and SHALL have no effect.

#### Scenario: Token for another launch
- **WHEN** launch L1's token is used against launch L2's endpoints
- **THEN** the response is 401 and no event is recorded

#### Scenario: Revoked launch
- **WHEN** a launch has been revoked by recovery and its process calls `report`
- **THEN** the response is 401 and the task state is unchanged

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
On `report submit` the orchestrator SHALL inspect the worktree. If it has uncommitted or untracked changes the call SHALL be rejected with 409 and the list of files, and the task SHALL remain `running`. If clean, the branch head SHALL be recorded as `sealedSha` and the task SHALL become `submitted`. Commits made after sealing SHALL be ignored by verification.

#### Scenario: Dirty worktree rejected
- **WHEN** an agent submits with an unstaged modification to `src/a.ts`
- **THEN** the response is 409 listing `src/a.ts` and the task is still `running`

#### Scenario: Later commits ignored
- **WHEN** an agent submits at commit C1 and then commits C2 on the same branch
- **THEN** verification uses C1

### Requirement: Declared no-op
If `sealedSha` equals `baseSha`, the submit report MUST carry `noChanges` with a justification; otherwise the submission SHALL fail with reason `emptySubmission` and `attempts` SHALL increase.

#### Scenario: Undeclared empty submission fails
- **WHEN** an agent submits with no commits ahead of `baseSha` and no `noChanges`
- **THEN** the task becomes `failed` with reason `emptySubmission`

#### Scenario: Declared no-op passes
- **WHEN** an agent submits with no commits and `noChanges.justification` set
- **THEN** the task is `submitted` and verification passes without publishing a commit

### Requirement: Acceptance evidence
When the brief contains acceptance criteria, the submit report MUST include an `acceptance` entry with evidence for each criterion; otherwise the submission SHALL fail with reason `missingAcceptanceEvidence`. The check is structural; the orchestrator does not judge the evidence.

#### Scenario: Missing evidence
- **WHEN** the brief lists two criteria and the report covers one
- **THEN** the task becomes `failed` with reason `missingAcceptanceEvidence` naming the uncovered criterion

### Requirement: Block and wait
`block` SHALL persist the question, move the task to `waiting`, release its run slot, and hold the connection open until an answer is delivered or `maxWait` elapses. An operator answer SHALL be persisted before any resume. The task SHALL return to `running` and the long-poll SHALL complete only after the scheduler admits it. A dropped connection SHALL be recoverable by re-issuing `block` with the same `seq`, which returns the stored answer once admitted. When `maxWait` elapses the task SHALL become `blocked` with the question preserved, and a later answer SHALL act as unblock-with-answer.

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
The brief and the MCP façade SHALL instruct the agent to retry the API with backoff for the retry window and then write `.orchestrator/report.json` and exit. The file SHALL carry `launchId`, `seq`, a kind of `submit`, `fail`, or `block`, and the body. Recovery SHALL apply the file when it finds the process dead, treating a fallback `block` as a transition to `blocked` with the question.

#### Scenario: Offline submission applied
- **WHEN** the API is unreachable, the agent writes a `submit` fallback file and exits, and the daemon later finds the process dead
- **THEN** the submission is sealed and applied as if it had been posted

#### Scenario: Offline question becomes blocked
- **WHEN** the agent writes a `block` fallback file and exits
- **THEN** the task is `blocked` with that question

### Requirement: MCP façade
A stdio MCP server launched per agent SHALL expose the five operations as tools, forward them to the HTTP API with the token from its environment, and retry through daemon restarts for the retry window before surfacing an error.

#### Scenario: Daemon restart during a call
- **WHEN** the daemon is restarting while an agent calls the `report` tool
- **THEN** the façade retries until the daemon is back and the call succeeds within the retry window

### Requirement: Brief validation and remediation
The brief template SHALL declare slots with a source, a `required` flag, and a minimum length, and the orchestrator SHALL validate a task against them when it becomes ready, or at ingest in strict mode. When validation fails, the configured policy SHALL either block the task with reason `insufficientSpec` listing the missing slots, or invoke the remediation hook to produce the missing content stored as a payload overlay keyed by graph revision. In `review` mode (default) the candidate SHALL land as `blocked` with kind `needsDecision` for a human to accept, edit, or reject; in `auto` mode it SHALL launch directly. v1 SHALL ship the hook interface with a default that blocks.

#### Scenario: Missing acceptance criteria blocks
- **WHEN** a ready task's payload has no acceptance criteria and the policy is `block`
- **THEN** the task is `blocked` with reason `insufficientSpec` listing `acceptanceCriteria`

#### Scenario: Review-mode candidate
- **WHEN** the policy is `remediate` in `review` mode and the hook returns a candidate
- **THEN** the task is `blocked` with kind `needsDecision` carrying the candidate, and unblock applies it to the payload overlay

### Requirement: Inbox notices for health
The inbox SHALL deliver notices of kind `stuck` with `idleMs` and a `message`, `nudge` with the operator's `message`, and `baseMoved` with the new integration `head` and the `files` its commit touched. The brief's workspace section SHALL state that such notices may arrive in the inbox, name the three kinds, tell the agent to check `inbox` after long steps, and state that rebasing the launch branch onto the integration head is allowed while merging into, pushing to, or checking out the integration branch is not.

#### Scenario: Nudge reaches the agent on its next inbox call
- **WHEN** an operator nudges a running task with "commit what you have"
- **THEN** the agent's next `inbox` call returns `{ kind: 'nudge', message: 'commit what you have' }` and the notice is not returned again

#### Scenario: Brief names the notices and allows rebasing
- **WHEN** a brief is composed
- **THEN** its workspace section names `stuck`, `nudge`, and `baseMoved` and says the launch branch may be rebased onto the integration head
