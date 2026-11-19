## MODIFIED Requirements

### Requirement: Remote workspace
`RemoteWorkspace` SHALL implement `Workspace` for remote launches without touching the filesystem: `prepare` and `remove` SHALL resolve doing nothing (`remove` resolving true), `fingerprint` SHALL resolve to a value fixed for the launch (its base sha and `remote`), `exists` SHALL resolve true, and `listWorktrees` SHALL resolve empty. `seal`, `preserve` and `readFallback` SHALL reject with an error that says `remote launch has no worktree` and names the launch.

#### Scenario: No-op calls
- **WHEN** `prepare`, `remove`, `fingerprint` and `exists` are called for a remote launch whose `worktree` names a path that does not exist
- **THEN** each resolves, `exists` resolves true, and nothing is created at or read from that path

#### Scenario: Tree-bound calls refuse
- **WHEN** `seal`, `preserve` or `readFallback` is called for remote launch L
- **THEN** it rejects with `remote launch has no worktree` naming L

### Requirement: Seal
The seal of a remote submit SHALL run through the daemon's shared origin: one fetch of origin's `refs/heads/<branch>` (the launch row's branch) into the daemon clone's `refs/heads/<branch>`, forced, on the same serial chain as every other remote command, after which the fetched tip SHALL be compared with the reported `sealedSha`.

#### Scenario: Pushed tip accepted and published
- **WHEN** the worker of remote launch L commits C on L's branch in its own clone, pushes it to origin, and submits with `sealedSha` C
- **THEN** the response is 200 with `outcome` `submitted`, the daemon clone's `refs/heads/<branch>` is C, and the verifier publishes the task to origin's integration branch with an `Orchestrator-Task` trailer

#### Scenario: Branch not pushed
- **WHEN** the worker submits with `sealedSha` C without pushing the launch branch
- **THEN** the response is 409 with `reason` `branchNotPushed` and the task is still `running`

#### Scenario: Another tip on origin
- **WHEN** the worker pushes commit C and submits with `sealedSha` set to C's parent
- **THEN** the response is 409 with `reason` `shaMismatch`, `expected` C's parent and `actual` C, the task is still `running`, and a resubmit with C is accepted

#### Scenario: Origin unreachable
- **WHEN** origin cannot be reached while a remote submit is sealed
- **THEN** the response is 503 with `reason` `originUnreachable`, no `agent.report` event is appended, and the task is still `running`

#### Scenario: Empty remote submission
- **WHEN** the pushed tip equals `baseSha` and the report has no `noChanges`
- **THEN** the submission fails with reason `emptySubmission`, as a local one does

## ADDED Requirements

### Requirement: Seal checks on a matching tip
When the tips of a remote seal match, the fetched tip SHALL be the `sealedSha`, and the submission checks (`emptySubmission`, acceptance evidence) SHALL run against the fetched tip and the launch's `baseSha` as for a local submit.

#### Scenario: Accepted report carries the sealed tip
- **WHEN** remote launch L's worker pushes commit C and submits with `sealedSha` C
- **THEN** the response carries `sealedSha` C, and the one `agent.report` event recorded for L is a `submit` whose payload has `sealedSha` C

### Requirement: Remote workspace integration calls
`integrationHead` and `tagMilestone` of `RemoteWorkspace` SHALL reject: the integration branch belongs to the daemon's own workspace.

#### Scenario: Integration calls refused by the remote workspace
- **WHEN** `integrationHead` or `tagMilestone` is called on a `RemoteWorkspace`
- **THEN** it rejects with an error saying the remote workspace holds no integration branch, and the daemon's workspace routed by access still answers `integrationHead` from its own workspace

### Requirement: Seal answers when origin lacks the sealed tip
When origin has no launch branch, the remote submit SHALL answer 409 `{ reason: 'branchNotPushed', branch }`; the answer SHALL come from origin, never from a ref an earlier fetch left in the clone. When origin's tip of the launch branch differs from the reported `sealedSha`, the remote submit SHALL answer 409 `{ reason: 'shaMismatch', branch, expected, actual }` with `expected` the reported `sealedSha` and `actual` origin's tip.

#### Scenario: Not-pushed answer comes from origin
- **WHEN** a remote seal fetches the launch branch and origin answers that it has no such remote ref
- **THEN** the seal returns `branchNotPushed` naming the branch, without reading the clone's own `refs/heads/<branch>`

### Requirement: Seal answers when origin cannot be fetched
When origin cannot be fetched (unreachable, timed out, or no remote configured), the remote submit SHALL answer 503 `{ reason: 'originUnreachable' }`; when origin refuses the credentials or access, 503 `{ reason: 'originRefused' }`.

#### Scenario: Refused fetch and missing remote
- **WHEN** the remote seal's fetch fails because origin refuses access, or because no remote is configured
- **THEN** the seal returns `originRefused` for the refusal and `originUnreachable` for the missing remote, and both are answered 503

### Requirement: Seal refusal leaves the task running
On any `branchNotPushed`, `shaMismatch`, `originUnreachable` or `originRefused` answer to a remote submit the task SHALL stay `running` and nothing SHALL be recorded, so the worker may retry.

#### Scenario: Retry after a refused seal
- **WHEN** a remote submit is answered 503 `originUnreachable`, origin then becomes reachable again, and the worker sends the same seq again
- **THEN** no `agent.report` event and no verifier job were recorded for the refused submit, the task stayed `running`, and the resubmit is accepted

### Requirement: Sealed commit stays in the clone
The fetched commit of a remote seal SHALL stay in the clone, where the verifier rebases it. No commit is made by the remote seal and the commit policy does not apply.

#### Scenario: Sealed commit rebased from the clone
- **WHEN** a remote submit with `sealedSha` C is accepted
- **THEN** the daemon clone's `refs/heads/<branch>` is C, and the verifier job's `sealedSha` is C

### Requirement: Remote seal preconditions
A seal called without a reported `sealedSha`, or on a daemon without an origin, SHALL reject as the tree-bound calls of "Remote workspace" do.

#### Scenario: Seal without a sealed sha or an origin
- **WHEN** `seal` is called on a `RemoteWorkspace` for remote launch L without a `sealedSha`, or on a `RemoteWorkspace` built without an origin
- **THEN** it rejects with `remote launch has no worktree` naming L

### Requirement: Remote launch keeps its fallback file and origin branch untouched
The fallback report file SHALL NOT be read for a remote launch, and the launch branch on origin SHALL NOT be deleted after publication.

#### Scenario: Fallback read refused for a remote launch
- **WHEN** the daemon's workspace, routed by access, is asked to read the fallback report of remote launch L
- **THEN** the call goes to `RemoteWorkspace` and rejects with `remote launch has no worktree` naming L, and no file is read
