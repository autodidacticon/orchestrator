## ADDED Requirements

### Requirement: Check command and tool rules in the brief
The brief's definition of done SHALL name the effective check command at the time the brief is composed. When `checkCommand` is unresolved the brief SHALL say that no check command is configured for the repository yet, that the operator is being asked, and that the agent must run the project's documented test suite before submitting. The brief's workspace section SHALL list the Bash rules in force for launches the daemon spawns, stating that a worker holding a claimed launch runs under its own permissions instead, SHALL tell the agent to run commands from the worktree root without `cd`, because every part of a compound command must match a rule on its own, and SHALL tell the agent to ask with a `needsAccess` question naming the command when it needs one the rules do not cover, rather than retrying it.

#### Scenario: Detected command in the brief
- **WHEN** a brief is composed in a repository whose detected check command is `npm test`
- **THEN** its definition of done says to run `npm test` before submitting and its workspace section lists `Bash(npm test:*)` among the rules

#### Scenario: Unresolved command in the brief
- **WHEN** a brief is composed while `checkCommand` is unresolved
- **THEN** it says no check command is configured yet and instructs the agent to run the project's documented tests before submitting

#### Scenario: Later brief reflects the change
- **WHEN** the operator sets `checkCommand` after T1's brief was written and T2 is prepared afterwards
- **THEN** T2's brief names the new command and T1's brief in its worktree is unchanged
