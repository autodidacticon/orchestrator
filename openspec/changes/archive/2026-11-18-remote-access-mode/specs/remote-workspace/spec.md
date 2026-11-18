## ADDED Requirements

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
