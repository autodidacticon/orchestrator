## MODIFIED Requirements

### Requirement: Progress signals
For every live launch whose task is `running` and whose process is alive, the daemon SHALL compute a progress fingerprint each tick: the branch head sha plus a hash of `git status --porcelain` and `git diff-index -p HEAD` for the worktree, both excluding `.orchestrator/`, so that a further edit to an already dirty file still registers. A touch that leaves a tracked file's content unchanged SHALL NOT change the fingerprint. The daemon SHALL record `progressAt` and `lastSignal` on the launch row when the fingerprint changes (`commit` when the head moved, otherwise `worktree`), when the agent makes any API call (`heartbeat`, `report`, `block`, `inbox`, `log`), when a heartbeat carries a `progress` text different from the previous one (`heartbeatText`, with the text kept as `progressText`), and when a `waiting` task resumes (`resumed`). A launch SHALL start with `progressAt` equal to `spawnedAt`, and its first fingerprint SHALL be a baseline that does not count as progress. A remote launch (`access: remote`) has no worktree on the daemon's host: the daemon SHALL NOT compute its fingerprint (no `Workspace.fingerprint` call at reconcile), and its fingerprint SHALL instead come from its worker's heartbeats. A heartbeat body MAY carry `fingerprint`, the clone's fingerprint computed as above (the head sha, a colon, the hash). For a remote launch a malformed `fingerprint` SHALL be answered 400 naming the field before anything is written; a well-formed one SHALL be compared with the stored fingerprint exactly as a daemon-read one is: the first is a baseline, a changed value SHALL be stored on the row and recorded as `commit` when the head part changed and otherwise `worktree`, and the same value again SHALL record nothing. A remote heartbeat that carries `fingerprint` SHALL count as progress only through its fingerprint or a new `progress` text, not as a `heartbeat` signal, so that a worker loop's periodic heartbeats renew the lease without hiding an agent that makes no progress; stuck detection SHALL then work unchanged on the stored remote fingerprint. For a local launch a heartbeat's `fingerprint` SHALL be ignored.

#### Scenario: Uncommitted edit is progress
- **WHEN** an agent modifies a tracked file in its worktree without committing and makes no API call
- **THEN** the next tick records `progressAt` with `lastSignal` `worktree`

#### Scenario: Commit is progress
- **WHEN** an agent commits on its launch branch
- **THEN** the next tick records `progressAt` with `lastSignal` `commit`

#### Scenario: Heartbeat text is progress
- **WHEN** an agent heartbeats with `progress` "writing tests" after an earlier "reading code"
- **THEN** `progressAt` is recorded with `lastSignal` `heartbeatText` and `progressText` "writing tests"

#### Scenario: Resume resets the idle clock
- **WHEN** a task that waited twenty minutes on a question is answered and admitted
- **THEN** `progressAt` is the resume time with `lastSignal` `resumed`

#### Scenario: Content-preserving touch is not progress
- **WHEN** a formatter or checkout rewrites a tracked file's mtime without changing its content, and the agent makes no API call
- **THEN** the next tick's fingerprint equals the previous one and no `progressAt` is recorded

#### Scenario: Reconcile reads no remote tree
- **WHEN** the daemon reconciles a live remote launch whose task is `running`, under a workspace that counts its calls
- **THEN** `Workspace.fingerprint` is called zero times, while a local launch's reconcile calls it once per tick as before

#### Scenario: Remote heartbeat fingerprint is progress
- **WHEN** a remote launch's heartbeats carry a baseline fingerprint, then one with the same head and another hash, then one with another head, then the last one again
- **THEN** the second records `lastSignal` `worktree`, the third `commit`, each stores its value on the row, and the fourth records no `progressAt`

#### Scenario: Local heartbeat fingerprint is ignored
- **WHEN** a heartbeat of a local launch carries a `fingerprint`
- **THEN** the stored fingerprint is unchanged and the call counts as a `heartbeat` signal

#### Scenario: Remote launch stuck behind unchanged heartbeats
- **WHEN** `health.stuckFailAfterMs` is 30000 and a remote launch's heartbeats renew its lease every 10 s with a changing fingerprint for 80 s, then with an unchanged one
- **THEN** it is not failed while the fingerprint changes, and it is failed with reason `stuck` once the fingerprint has not changed for more than 30 s, as a local launch without progress is
