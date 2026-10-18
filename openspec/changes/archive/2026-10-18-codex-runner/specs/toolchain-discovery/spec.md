## MODIFIED Requirements

### Requirement: Runner command composition
Each runner kind SHALL have one command template with its own slots.

`DEFAULT_CLAUDE_COMMAND` SHALL be a template with an `{allowedTools}` slot in place of the fixed `--allowedTools` list, and with `{model}` and `{effort}` slots carrying `--model {model} --effort {effort}`. At every spawn the Claude Code runner SHALL substitute:
- `{allowedTools}` with the effective allow list, each rule double-quoted and space-separated;
- `{model}` and `{effort}` with the launch's model and effort;
- the existing `{brief}`, `{worktree}`, `{launchId}`, and `{mcpConfig}`.

`DEFAULT_CODEX_COMMAND` SHALL carry `{model}`, `{effort}`, `{sandbox}`, `{ephemeral}`, `{ignoreUserConfig}`, and `{codexOverrides}` and no `{allowedTools}` (see worker-runners "Codex runner command composition"). The Codex runner SHALL fill these slots at every spawn alongside the common ones.

A runner-specific slot SHALL reach the template through the subprocess runner's `extraVars`. Substitution SHALL be one pass over the template with `\{(\w+)\}`, so a substituted value, such as a TOML inline table, is never re-substituted.

A `runnerCommand` (or `runner.codex.command`) from the file or an argument that contains a slot SHALL be filled the same way. One without a slot SHALL run verbatim for that slot, and the configuration record SHALL mark the corresponding key as not applied.

The composed command SHALL be read at spawn time, so a change to the list or the template reaches every launch spawned afterwards and no launch already live.

#### Scenario: Default template filled
- **WHEN** a launch is spawned in a Node repository with no file
- **THEN** the command run contains `--allowedTools "Bash(git:*)" "mcp__orchestrator__heartbeat" "mcp__orchestrator__report" "mcp__orchestrator__block" "mcp__orchestrator__inbox" "mcp__orchestrator__log" "Bash(npm test:*)"` followed by the remaining node rules, and `--model claude-opus-5-5 --effort medium`

#### Scenario: Codex template filled
- **WHEN** `DEFAULT_CODEX_COMMAND` is filled for a launch
- **THEN** no `{…}` slot remains, and `hasModelSlot` and `hasEffortSlot` are true while `hasAllowedToolsSlot` is false

#### Scenario: Verbatim command without the slot
- **WHEN** the file sets `runnerCommand` to a command with its own fixed `--allowedTools` list and no `{allowedTools}`, `{model}`, or `{effort}`
- **THEN** that command runs unchanged and `config.allowedTools.applied`, `config.model.applied`, and `config.effort.applied` are false

#### Scenario: Later launches pick up a change
- **WHEN** `Bash(docker:*)` is added through the configuration route while T1's agent is live and T2 is launched afterwards
- **THEN** T2's command contains `Bash(docker:*)` and T1's process is unchanged
