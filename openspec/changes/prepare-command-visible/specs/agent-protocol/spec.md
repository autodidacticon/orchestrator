## ADDED Requirements

### Requirement: Prepare command in the brief
The brief of a launch prepared while `prepareCommand` is set SHALL carry, in "Definition of done" directly after the check command bullet, the bullet `` - Dependencies are installed: the orchestrator ran `<prepareCommand>` in this worktree before you started, outside any sandbox. Do not run it again unless your change needs it. ``, and `brief.json` SHALL carry `prepareCommand`. Both SHALL be absent when the key is unset. The command's output SHALL never be in the brief.

#### Scenario: Bullet after the check command bullet
- **WHEN** a brief is composed with `prepareCommand: "npm ci"`
- **THEN** the line after the check command bullet is the prepare bullet naming `npm ci`, and `brief.json` has `prepareCommand: "npm ci"`

#### Scenario: Order beside the Codex network bullet
- **WHEN** a Codex launch without network access is prepared with a prepare command
- **THEN** the check command bullet, the prepare bullet and the network bullet appear in that order

#### Scenario: Every runner kind and mode
- **WHEN** a launch of any runner kind is prepared in `spawn`, `pull` or `mixed` mode with the key set
- **THEN** its brief carries the bullet

#### Scenario: Key unset
- **WHEN** `prepareCommand` is unset
- **THEN** the brief has no such bullet, `brief.json` has no `prepareCommand`, and the golden briefs are unchanged
