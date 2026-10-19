## MODIFIED Requirements

### Requirement: Derived allowed tools
When the runner kind in force is `claude-code`, the daemon SHALL derive the allow list for the agents it spawns from the toolchains found in the repository root: the base rules `Bash(git:*)`, `mcp__orchestrator__heartbeat`, `mcp__orchestrator__report`, `mcp__orchestrator__block`, `mcp__orchestrator__inbox`, and `mcp__orchestrator__log` always; for a `node` toolchain with package manager `<pm>`, `Bash(<pm> test:*)`, `Bash(<pm> run:*)`, `Bash(<pm> install:*)`, `Bash(<pm> exec:*)`, `Bash(node:*)`, plus `Bash(npm ci:*)` and `Bash(npx:*)` for npm, `Bash(npx:*)` for pnpm and yarn, and `Bash(bunx:*)` for bun; for `rust`, `Bash(cargo:*)`; for `go`, `Bash(go:*)`; for `python`, `Bash(pytest:*)`, `Bash(python:*)`, `Bash(python3:*)`, `Bash(pip:*)`, plus `Bash(uv:*)` when `uv.lock` exists and `Bash(poetry:*)` when `poetry.lock` exists; for `make`, `Bash(make:*)`; for `ruby`, `Bash(bundle:*)`, `Bash(rake:*)`, `Bash(rspec:*)`, `Bash(ruby:*)`; for `gradle`, `Bash(./gradlew:*)` and `Bash(gradle:*)`; for `maven`, `Bash(mvn:*)` and `Bash(./mvnw:*)`; for `elixir`, `Bash(mix:*)` and `Bash(elixir:*)`; for `dotnet`, `Bash(dotnet:*)`. Rules from `runner.claude.allowedTools` in the file and from arguments SHALL be appended. `runner.claude.deriveTools: false` SHALL drop the toolchain rules and keep the base rules and the added ones. A rule containing a double quote, backslash, dollar sign, or backtick SHALL be rejected at configuration time. The list SHALL be passed as `--allowedTools`, which adds a source of approval beside the repository's own `.claude/settings.json` and `.claude/settings.local.json` rules and never replaces them; a deny rule in those files wins over the list, as Claude Code evaluates deny before allow at every level. The derived list SHALL apply only to launches the daemon spawns (`spawn` mode, and `mixed` mode once the claim window elapses); a launch a worker claims runs under the worker's own permissions and SHALL NOT be given the list. Allow-list composition is specific to `claude-code`: when the kind in force is `codex` or `opencode`, `config.allowedTools` SHALL be `{ value: [], source: "composed", applied: false }` with empty parts, and the runner's own policies apply instead (see worker-runners). The derived `Bash(...)` rules SHALL also feed the OpenCode permission ruleset under `runner.opencode.permission: derived`: `Bash(x:*)` becomes the bash pattern `"x *"` and `Bash(x)` becomes `"x"` (see worker-runners "OpenCode runner command composition"). The plugin's default mode and the work workflow are decided by the sibling change `add-daemon-lifecycle`, not here.

#### Scenario: Node rules derived
- **WHEN** the repository has `package.json` with a test script and no lockfile
- **THEN** the effective allow list is the base rules followed by `Bash(npm test:*)`, `Bash(npm run:*)`, `Bash(npm install:*)`, `Bash(npm exec:*)`, `Bash(node:*)`, `Bash(npm ci:*)`, and `Bash(npx:*)`

#### Scenario: Several toolchains contribute
- **WHEN** the repository has a `Makefile` with a `test` target and `Cargo.toml`
- **THEN** the allow list contains `Bash(make:*)` and `Bash(cargo:*)` after the base rules

#### Scenario: File extends without copying the command
- **WHEN** `orchestrator.yaml` sets `runner.claude.allowedTools: ["Bash(docker:*)"]` and nothing else
- **THEN** the allow list is the derived list followed by `Bash(docker:*)`, and the runner command is still the default template

#### Scenario: Derivation turned off
- **WHEN** the file sets `runner.claude.deriveTools: false` and `runner.claude.allowedTools: ["Bash(make:*)"]` in a Node repository
- **THEN** the allow list is the base rules followed by `Bash(make:*)` and contains no `npm` rule

#### Scenario: Unsafe rule rejected
- **WHEN** a `start` argument adds the rule `Bash(echo "$HOME")`
- **THEN** the argument is refused with 400 naming the rule and nothing changes

#### Scenario: Claimed launch gets no list
- **WHEN** a worker claims a launch in `pull` mode
- **THEN** no runner command is composed for it and the claim response carries no allow list

#### Scenario: No list under Codex
- **WHEN** the file sets `runner.kind: codex` in a Node repository
- **THEN** `config.allowedTools` has `value: []`, empty parts, and `applied: false`

#### Scenario: Derived rules as OpenCode bash patterns
- **WHEN** an opencode launch is spawned with the derived rules `Bash(git:*)`, `Bash(npm test:*)`, and `Bash(git status)` under `permission: derived`
- **THEN** its permission ruleset allows the bash patterns `git *`, `npm test *`, and `git status`

### Requirement: Runner command composition
Each runner kind SHALL have one command template with its own slots.

`DEFAULT_CLAUDE_COMMAND` SHALL be a template with an `{allowedTools}` slot in place of the fixed `--allowedTools` list, and with `{model}` and `{effort}` slots carrying `--model {model} --effort {effort}`. At every spawn the Claude Code runner SHALL substitute:
- `{allowedTools}` with the effective allow list, each rule double-quoted and space-separated;
- `{model}` and `{effort}` with the launch's model and effort;
- the existing `{brief}`, `{worktree}`, `{launchId}`, and `{mcpConfig}`.

`DEFAULT_CODEX_COMMAND` SHALL carry `{model}`, `{effort}`, `{sandbox}`, `{ephemeral}`, `{ignoreUserConfig}`, and `{codexOverrides}` and no `{allowedTools}` (see worker-runners "Codex runner command composition"). The Codex runner SHALL fill these slots at every spawn alongside the common ones.

`DEFAULT_OPENCODE_COMMAND` SHALL carry `{pure}`, `{model}`, and `{variant}` (which carries the effort as `--variant <effort>`) and no `{allowedTools}`; its permissions travel in the per-launch config instead (see worker-runners "OpenCode runner command composition"). `hasEffortSlot` SHALL recognise `{effort}` or `{variant}`.

A runner with slots of its own SHALL compose the whole command through the subprocess runner's `compose` hook (the Codex runner's `composeCodexCommand`, shared with the Codex work loop); the subprocess runner itself substitutes only the common slots and the allow list. Substitution SHALL be one pass over the template with `\{(\w+)\}`, so a substituted value, such as a TOML inline table, is never re-substituted.

A `runnerCommand` (or `runner.codex.command`) from the file or an argument that contains a slot SHALL be filled the same way. One without a slot SHALL run verbatim for that slot, and the configuration record SHALL mark the corresponding key as not applied.

The composed command SHALL be read at spawn time, so a change to the list or the template reaches every launch spawned afterwards and no launch already live.

#### Scenario: Default template filled
- **WHEN** a launch is spawned in a Node repository with no file
- **THEN** the command run contains `--allowedTools "Bash(git:*)" "mcp__orchestrator__heartbeat" "mcp__orchestrator__report" "mcp__orchestrator__block" "mcp__orchestrator__inbox" "mcp__orchestrator__log" "Bash(npm test:*)"` followed by the remaining node rules, and `--model claude-opus-5-5 --effort medium`

#### Scenario: Codex template filled
- **WHEN** `DEFAULT_CODEX_COMMAND` is filled for a launch
- **THEN** no `{…}` slot remains, and `hasModelSlot` and `hasEffortSlot` are true while `hasAllowedToolsSlot` is false

#### Scenario: OpenCode template filled
- **WHEN** `DEFAULT_OPENCODE_COMMAND` is filled for a launch
- **THEN** no `{…}` slot remains, and `hasModelSlot` and `hasEffortSlot` are true while `hasAllowedToolsSlot` is false

#### Scenario: Verbatim command without the slot
- **WHEN** the file sets `runnerCommand` to a command with its own fixed `--allowedTools` list and no `{allowedTools}`, `{model}`, or `{effort}`
- **THEN** that command runs unchanged and `config.allowedTools.applied`, `config.model.applied`, and `config.effort.applied` are false

#### Scenario: Later launches pick up a change
- **WHEN** `Bash(docker:*)` is added through the configuration route while T1's agent is live and T2 is launched afterwards
- **THEN** T2's command contains `Bash(docker:*)` and T1's process is unchanged
