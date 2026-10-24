## MODIFIED Requirements

### Requirement: Progress signals
For every live launch whose task is `running` and whose process is alive, the daemon SHALL compute a progress fingerprint each tick: the branch head sha plus a hash of `git status --porcelain` and `git diff-index -p HEAD` for the worktree, both excluding `.orchestrator/`, so that a further edit to an already dirty file still registers. A touch that leaves a tracked file's content unchanged SHALL NOT change the fingerprint. The daemon SHALL record `progressAt` and `lastSignal` on the launch row when the fingerprint changes (`commit` when the head moved, otherwise `worktree`), when the agent makes any API call (`heartbeat`, `report`, `block`, `inbox`, `log`), when a heartbeat carries a `progress` text different from the previous one (`heartbeatText`, with the text kept as `progressText`), and when a `waiting` task resumes (`resumed`). A launch SHALL start with `progressAt` equal to `spawnedAt`, and its first fingerprint SHALL be a baseline that does not count as progress.

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

### Requirement: Worktree observation takes no index lock
The daemon's git commands SHALL run with `GIT_OPTIONAL_LOCKS=0`. Its read-only git commands against a launch worktree SHALL never write the worktree's index or create its `index.lock`, so they never make the agent's own concurrent git command fail. The progress fingerprint SHALL therefore use `git status --porcelain`, which under `GIT_OPTIONAL_LOCKS=0` skips its index refresh, and the plumbing `git diff-index -p HEAD`, which never refreshes the index; it SHALL NOT use porcelain `git diff`, which refreshes the index and takes `index.lock` regardless of `GIT_OPTIONAL_LOCKS`. Commands that write SHALL take their locks as before.

#### Scenario: Agent commits while the daemon fingerprints
- **WHEN** an agent runs `git commit` in its worktree during the same tick in which the daemon computes that launch's progress fingerprint
- **THEN** the commit does not fail with "Unable to create '.../index.lock': File exists", and the launch is not failed as `exitedWithoutReport`

#### Scenario: Stat-dirty entries do not make the fingerprint write the index
- **WHEN** a tracked file in a launch worktree is touched without a content change, so its index entry is stat-dirty, and the daemon computes the fingerprint
- **THEN** the worktree's `.git/index` keeps its inode and mtime and no `index.lock` is created

#### Scenario: Observation still sees uncommitted edits
- **WHEN** an agent modifies a tracked file without committing
- **THEN** the next tick's fingerprint differs from the previous one and `progressAt` is recorded with `lastSignal` `worktree`, as without the setting
