## ADDED Requirements

### Requirement: Worktree observation takes no index lock
The daemon's read-only git commands against a launch worktree, such as the progress fingerprint's `git status` and `git diff HEAD`, SHALL run with `GIT_OPTIONAL_LOCKS=0`, so they never create the worktree's `index.lock` and never make the agent's own concurrent git command fail. Commands that write SHALL take their locks as before.

#### Scenario: Agent commits while the daemon fingerprints
- **WHEN** an agent runs `git commit` in its worktree during the same tick in which the daemon computes that launch's progress fingerprint
- **THEN** the commit does not fail with "Unable to create '.../index.lock': File exists", and the launch is not failed as `exitedWithoutReport`

#### Scenario: Observation still sees uncommitted edits
- **WHEN** an agent modifies a tracked file without committing
- **THEN** the next tick's fingerprint differs from the previous one and `progressAt` is recorded with `lastSignal` `worktree`, as without the setting
