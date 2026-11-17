## ADDED Requirements

### Requirement: Run skill names the Codex network access override

The paragraph of each run skill (Claude Code, Codex and OpenCode editions) that lists what `configure` also takes SHALL name `networkAccess` (`codex.networkAccess`, `true` or `false`, for launches spawned or claimed after the change), SHALL say that it widens what a Codex worker can reach, and SHALL say that it is set only when the user says so. The Codex and OpenCode editions SHALL use the same words. The skills SHALL NOT offer the key as a remedy for a `needsAccess` question.

#### Scenario: The configure paragraph names the key and its risk
- **WHEN** a run skill is split at blank lines and the block that holds `` `configure` also takes `` is read with its whitespace collapsed
- **THEN** it holds `networkAccess`, `widens what a Codex worker can reach` and `only when the user says so`

#### Scenario: The session does not choose network access itself
- **WHEN** a Codex worker asks with `needsAccess` for a command that needs the network
- **THEN** the run skill does not tell the session to set `networkAccess`
- **AND** the session sets it only when the user says so
