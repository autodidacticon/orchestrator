# remote-workspace Specification

## Purpose
TBD - created by archiving change remote-access-mode. Update Purpose after archive.
## Requirements
### Requirement: Remote launch preparation
On a run whose `runner.access` is `remote`, preparing a launch SHALL create no worktree and no directory under the run's worktrees root. The launch row SHALL have `access: 'remote'`, `worktree` the empty string, and the brief composed as for a local launch stored on the row as `briefMarkdown` (the markdown) and `briefJson` (the JSON). The launch SHALL then be parked `claimable` as any pull-mode launch. The branch name, base sha, token and selection SHALL be fixed as for a local launch.

#### Scenario: Admission on a remote run
- **WHEN** a remote run admits task T1
- **THEN** T1's launch row has `access: 'remote'`, `worktree: ''`, non-empty `briefMarkdown` and `briefJson`, and status `claimable`, and the run's worktrees root holds nothing

### Requirement: Remote workspace
`RemoteWorkspace` SHALL implement `Workspace` for remote launches without touching the filesystem: `prepare` and `remove` SHALL resolve doing nothing (`remove` resolving true), `fingerprint` SHALL resolve to a value fixed for the launch (its base sha and `remote`), `exists` SHALL resolve true, and `listWorktrees` SHALL resolve empty. `seal`, `preserve` and `readFallback` SHALL reject with an error that says `remote launch has no worktree` and names the launch. `integrationHead` and `tagMilestone` SHALL reject: the integration branch belongs to the daemon's own workspace.

#### Scenario: No-op calls
- **WHEN** `prepare`, `remove`, `fingerprint` and `exists` are called for a remote launch whose `worktree` names a path that does not exist
- **THEN** each resolves, `exists` resolves true, and nothing is created at or read from that path

#### Scenario: Tree-bound calls refuse
- **WHEN** `seal`, `preserve` or `readFallback` is called for remote launch L
- **THEN** it rejects with `remote launch has no worktree` naming L

### Requirement: Workspace by access
The daemon SHALL keep its git workspace for the verifier, base selection, milestone tags and the worktree sweep. Every launch-side workspace call (`prepare`, `seal`, `readFallback`, `remove`, `fingerprint`, `exists`, `preserve`) SHALL go to the workspace chosen by the launch's `access`: the remote workspace for `remote`, the git workspace otherwise.

#### Scenario: Restart with a parked remote launch
- **WHEN** the daemon restarts on the same store while a remote launch is parked `claimable`
- **THEN** the launch stays `claimable` with the same launch id and token, no `launch.reprepared` is appended for it, and no worktree is created

### Requirement: Seal
The seal of a remote submit SHALL run through the daemon's shared origin: one fetch of origin's `refs/heads/<branch>` (the launch row's branch) into the daemon clone's `refs/heads/<branch>`, forced, on the same serial chain as every other remote command, after which the fetched tip SHALL be compared with the reported `sealedSha`. When origin has no such branch, the submit SHALL answer 409 `{ reason: 'branchNotPushed', branch }`; the answer SHALL come from origin, never from a ref an earlier fetch left in the clone. When origin's tip differs, the submit SHALL answer 409 `{ reason: 'shaMismatch', branch, expected, actual }` with `expected` the reported `sealedSha` and `actual` origin's tip. When origin cannot be fetched (unreachable, timed out, or no remote configured), the submit SHALL answer 503 `{ reason: 'originUnreachable' }`; when origin refuses the credentials or access, 503 `{ reason: 'originRefused' }`. On any of these the task SHALL stay `running` and nothing SHALL be recorded, so the worker may retry. When the tips match, the fetched tip SHALL be the `sealedSha`, and the submission checks (`emptySubmission`, acceptance evidence) SHALL run against it and the launch's `baseSha` as for a local submit. The fetched commit SHALL stay in the clone, where the verifier rebases it. No commit is made and the commit policy does not apply. A seal called without a reported `sealedSha`, or on a daemon without an origin, SHALL reject as the tree-bound calls of "Remote workspace" do. The fallback report file SHALL NOT be read for a remote launch, and the launch branch on origin SHALL NOT be deleted after publication.

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

### Requirement: Remote launch end
The end of a remote launch, by release, lease expiry or any other path through the loop's release and expiry, SHALL NOT call `Workspace.fingerprint`, `Workspace.preserve` or `Workspace.remove` for it: the daemon holds no tree for a remote launch, and its work lives on the launch branch at origin. A kept remote release SHALL read the branch at origin instead (a fetch for a release with `keep`, `ls-remote` for a lease expiry), as specs/pull-runner "Release" and "Lease expiry" state.

#### Scenario: Kept remote release touches no tree
- **WHEN** a remote worker releases with `keep` and the pushed `headSha`, under a workspace that counts its calls
- **THEN** the release is kept and `fingerprint`, `preserve` and `remove` were each called zero times

#### Scenario: Remote expiry touches no tree
- **WHEN** a remote launch's lease expires after a push
- **THEN** the expiry is kept and neither `preserve` nor `remove` was called

