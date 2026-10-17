## MODIFIED Requirements

### Requirement: Runner command composition
`DEFAULT_CLAUDE_COMMAND` SHALL be a template with an `{allowedTools}` slot in place of the fixed `--allowedTools` list and with `{model}` and `{effort}` slots carrying `--model {model} --effort {effort}`. At every spawn the Claude Code runner SHALL substitute `{allowedTools}` with the effective allow list, each rule double-quoted and space-separated, and `{model}` and `{effort}` with the launch's model and effort, alongside the existing `{brief}`, `{worktree}`, `{launchId}`, and `{mcpConfig}` substitutions. A `runnerCommand` from the file or an argument that contains a slot SHALL be filled the same way; one without a slot SHALL run verbatim for that slot, and the configuration record SHALL mark the corresponding key as not applied. The composed command SHALL be read at spawn time, so a change to the list or the template reaches every launch spawned afterwards and no launch already live.

#### Scenario: Default template filled
- **WHEN** a launch is spawned in a Node repository with no file
- **THEN** the command run contains `--allowedTools "Bash(git:*)" "mcp__orchestrator__heartbeat" "mcp__orchestrator__report" "mcp__orchestrator__block" "mcp__orchestrator__inbox" "mcp__orchestrator__log" "Bash(npm test:*)"` followed by the remaining node rules, and `--model claude-opus-5-5 --effort medium`

#### Scenario: Verbatim command without the slot
- **WHEN** the file sets `runnerCommand` to a command with its own fixed `--allowedTools` list and no `{allowedTools}`, `{model}`, or `{effort}`
- **THEN** that command runs unchanged and `config.allowedTools.applied`, `config.model.applied`, and `config.effort.applied` are false

#### Scenario: Later launches pick up a change
- **WHEN** `Bash(docker:*)` is added through the configuration route while T1's agent is live and T2 is launched afterwards
- **THEN** T2's command contains `Bash(docker:*)` and T1's process is unchanged

### Requirement: Resolved configuration record
The daemon SHALL keep the operator overrides durable in the store under one document and SHALL write the resolved configuration to `<runDir>/config.json` beside `daemon.json`, atomically, at every start and after every accepted override. The record SHALL carry the resolution time, the repository path, every configuration key with its value and source (nested blocks per leaf; `allowedTools` with its parts and whether it is applied; `model` and `effort` each with whether it is applied), the detection record under `toolchain`, the overrides in force, and `needsConfig`: the keys whose value is `unresolved`. The file SHALL be informational: `status` SHALL compute the same facts live and never read the file. The daemon SHALL append a `config.resolved` event with the provenance and detection summary at every start and after every accepted override.

#### Scenario: Record written at start
- **WHEN** the daemon starts in a Node repository without a file
- **THEN** `config.json` exists in the run directory with `checkCommand` `{ value: "npm test", source: "detected" }`, `capacity` `{ value: 2, source: "default" }`, `model` `{ value: "claude-opus-5-5", source: "default", applied: true }`, `effort` `{ value: "medium", source: "default", applied: true }`, a `toolchain` block naming `node`, and an empty `needsConfig`

#### Scenario: Record follows an override
- **WHEN** `PUT /v1/config` sets `capacity` to 3
- **THEN** `config.json` shows `capacity` `{ value: 3, source: "argument" }`, the event log holds `operator.config` followed by `config.resolved`, and `status.config.capacity` agrees

#### Scenario: Overrides survive a restart
- **WHEN** `checkCommand` was set through the route and the daemon is restarted without arguments
- **THEN** the effective check command is still the one set, with source `argument`

### Requirement: Runtime overrides and start-only keys
`checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `model`, and `effort` SHALL be overridable while the daemon runs: `checkCommand` applies to every verifier job that starts checking after the change, `capacity` to the next admission pass, `allowedTools` and `runnerCommand` to every launch spawned after the change, and `model` and `effort` to every launch prepared after the change. `integrationBranch` SHALL be start-only: it is accepted as a `start` argument that spawns the daemon, subject to pinning, and refused with 409 naming it as start-only on a running daemon. Setting a key to null SHALL clear its override so the value falls back to the next layer. A request that mixes a start-only key with other keys SHALL be refused whole and apply nothing. `capacity` SHALL be a positive integer, `checkCommand` and `runnerCommand` non-empty strings, `allowedTools` a list of safe rules, `effort` one of `low`, `medium`, `high`, `xhigh`, `max`, and `model` a string matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`; anything else SHALL be refused with 400 naming the key.

#### Scenario: Check command applies to the next job
- **WHEN** T1's job is `checking` with command A and the operator sets `checkCommand` to B before T2 is submitted
- **THEN** T1's job finishes with A and T2's job runs B

#### Scenario: Capacity change admits on the next pass
- **WHEN** two tasks are running at capacity 2 with a third ready and the operator sets `capacity` to 3
- **THEN** the third task is launched on the next tick

#### Scenario: Start-only key refused while running
- **WHEN** `PUT /v1/config` carries `integrationBranch: develop` and `capacity: 3` on a running daemon
- **THEN** the response is 409 naming `integrationBranch` as start-only and the capacity is unchanged

#### Scenario: Clearing an override
- **WHEN** `checkCommand` was set to `make check` by argument in a repository whose detection found `npm test`, and the operator sets it to null
- **THEN** the effective check command is `npm test` with source `detected`

#### Scenario: Invalid value refused
- **WHEN** `PUT /v1/config` carries `capacity: 0`
- **THEN** the response is 400 naming `capacity` and nothing changes

#### Scenario: Invalid effort refused
- **WHEN** `PUT /v1/config` carries `effort: "huge"`
- **THEN** the response is 400 naming `effort` and nothing changes

#### Scenario: Model applies to the next prepared launch
- **WHEN** T1's launch is parked claimable under `claude-opus-5-5` and the operator sets `model` to `claude-sonnet-5-5` before T2 is prepared
- **THEN** T1's claim response still says `claude-opus-5-5` and T2's launch has `claude-sonnet-5-5`
