## ADDED Requirements

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
