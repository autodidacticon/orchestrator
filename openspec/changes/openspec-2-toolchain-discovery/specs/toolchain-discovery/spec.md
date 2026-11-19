## MODIFIED Requirements

### Requirement: Resolution order and provenance
Every configurable value SHALL be resolved from four layers in this order: an explicit argument (a `start` argument, an `orchestrator-ctl start --set` flag, or a daemon `--set key=value` flag, each stored as a durable override for the run), then `<repo>/orchestrator.yaml` when the file is present and names the key, then, for `integrationBranch` only, the branch pinned in the store for the run, then detection from the repository, then the built-in default.

#### Scenario: File beats detection
- **WHEN** `orchestrator.yaml` sets `checkCommand: make check` in a repository whose `package.json` has a `test` script
- **THEN** the effective check command is `make check` with source `file` and the detection is still recorded under `toolchain`

#### Scenario: Argument beats file
- **WHEN** the file sets `capacity: 2` and the daemon was started with `--set capacity=3`
- **THEN** the effective capacity is 3 with source `argument`

#### Scenario: Detection beats the default
- **WHEN** no file is present and the repository has `go.mod`
- **THEN** the effective check command is `go test ./...` with source `detected` and the integration branch records `detected` or `default` according to the repository

#### Scenario: Lists compose
- **WHEN** detection derives `Bash(npm test:*)`, the file adds `Bash(docker:*)`, and a `start` argument adds `Bash(make:*)`
- **THEN** the effective allow list contains all three in that order after the base rules, with source `composed` and each rule attributed to its layer

#### Scenario: Nothing supplies the check command
- **WHEN** no file is present and the repository root has no recognised manifest
- **THEN** `checkCommand` is `unresolved` and `npm test` is not used

#### Scenario: Per-kind keys take their kind's layers
- **WHEN** the file sets `runner.kind: codex` and `runner.codex.model: gpt-6-pro`, and a `--set codex.sandbox=read-only` flag was given
- **THEN** `runnerKind` has source `file`, `model` is `gpt-6-pro` with source `file`, `codex.sandbox` is `read-only` with source `argument`, and `codex.effort` is `medium` with source `default`

### Requirement: Toolchain detection
At daemon start the daemon SHALL inspect the repository root, never subdirectories, against this table in this order and SHALL take the check command of the first row that matches: a `Makefile` (or `GNUmakefile`, `makefile`) containing a line that defines a `test` target gives `make test`; a `package.json` whose `scripts.test` is a non-empty string other than npm's placeholder (`echo "Error: no test specified" && exit 1`) gives `<pm> test` with the package manager chosen as specified below.

#### Scenario: Node project with a test script
- **WHEN** the root has `package.json` with `"test": "vitest run"` and `package-lock.json`
- **THEN** the detected check command is `npm test` and the record names the `node` toolchain, `package.json`, and `npm`

#### Scenario: Placeholder test script is not a test
- **WHEN** the root has `package.json` whose `test` script is npm's placeholder and nothing else matches
- **THEN** `checkCommand` is unresolved, the `node` toolchain is still recorded as found, and the reason says the script is the placeholder

#### Scenario: Makefile wins over a language manifest
- **WHEN** the root has a `Makefile` with a `test` target, `go.mod`, and `package.json` with a test script
- **THEN** the detected check command is `make test` and the record lists the `make`, `go`, and `node` toolchains as found

#### Scenario: Python with uv
- **WHEN** the root has `pyproject.toml` and `uv.lock`
- **THEN** the detected check command is `uv run pytest`

#### Scenario: Ruby with rspec
- **WHEN** the root has `Gemfile` and `.rspec`
- **THEN** the detected check command is `bundle exec rspec`

#### Scenario: Gradle without a wrapper
- **WHEN** the root has `build.gradle.kts` and no `gradlew`
- **THEN** the detected check command is `gradle test`

#### Scenario: Manifest in a subdirectory is ignored
- **WHEN** the only `package.json` is under `packages/app/`
- **THEN** nothing is detected from it and `checkCommand` is unresolved unless another row matches

#### Scenario: Reasons explain the choice
- **WHEN** detection runs on a repository with `package.json` and `pnpm-lock.yaml`
- **THEN** the record's reasons include a line naming `pnpm-lock.yaml` as the reason for `pnpm`

### Requirement: Integration branch detection and pinning
When neither an argument nor the file sets `integrationBranch`, the daemon SHALL use the branch pinned in the store for the run when one is recorded, with provenance `pinned`; otherwise it SHALL detect the branch that `refs/remotes/origin/HEAD` points at when that symbolic ref exists and the branch exists locally as `refs/heads/<name>`, else the branch `HEAD` is on when it is on a branch, else `main`, and SHALL pin the result in the store together with `baselineHead`.

#### Scenario: origin/HEAD names the branch
- **WHEN** a run starts for the first time, `refs/remotes/origin/HEAD` points at `origin/develop`, `develop` exists locally, and `main` is checked out
- **THEN** the integration branch is `develop` with source `detected` and `develop` is pinned in the store

#### Scenario: Current branch without a remote
- **WHEN** a run starts for the first time in a repository with no remote and `trunk` checked out
- **THEN** the integration branch is `trunk` with source `detected`

#### Scenario: Detached head falls back to main
- **WHEN** a run starts for the first time with no `origin/HEAD` and `HEAD` detached
- **THEN** the integration branch is `main` with source `default`

#### Scenario: Detected branch moves mid-run
- **WHEN** a run pinned `main`, holds one launch, and is started again after `origin/HEAD` was re-pointed at `origin/develop` and `develop` was checked out in the main checkout
- **THEN** the daemon starts and the integration branch is `main` with source `pinned`

#### Scenario: Branch change refused mid-run
- **WHEN** a run pinned `main`, holds one launch, and is started again with `--set integrationBranch=develop`
- **THEN** the daemon exits without serving, and its log names `main`, `develop`, and the remedy

#### Scenario: Explicit branch adopted on an untouched run
- **WHEN** a run pinned `main`, holds no launch and no job, and `orchestrator.yaml` now sets `integrationBranch: develop`
- **THEN** the daemon starts on `develop` with source `file`, and the pin and `baselineHead` are re-recorded from `develop`

### Requirement: Derived allowed tools
When the runner kind in force is `claude-code`, the daemon SHALL derive the allow list for the agents it spawns from the toolchains found in the repository root: the base rules `Bash(git:*)`, `mcp__orchestrator__heartbeat`, `mcp__orchestrator__report`, `mcp__orchestrator__block`, `mcp__orchestrator__inbox`, and `mcp__orchestrator__log` always.

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

`DEFAULT_CLAUDE_COMMAND` SHALL be a template with an `{allowedTools}` slot in place of the fixed `--allowedTools` list, and with `{model}` and `{effort}` slots carrying `--model {model} --effort {effort}`.

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

### Requirement: Resolved configuration record
The daemon SHALL keep the operator overrides durable in the store under one document and SHALL write the resolved configuration to `<runDir>/config.json` beside `daemon.json`, atomically, at every start and after every accepted override.

#### Scenario: Record written at start
- **WHEN** the daemon starts in a Node repository without a file
- **THEN** `config.json` exists in the run directory with `checkCommand` `{ value: "npm test", source: "detected" }`, `capacity` `{ value: 2, source: "default" }`, `model` `{ value: "claude-opus-5-5", source: "default", applied: true }`, `effort` `{ value: "medium", source: "default", applied: true }`, a `toolchain` block naming `node`, and an empty `needsConfig`

#### Scenario: Record follows an override
- **WHEN** `PUT /v1/config` sets `capacity` to 3
- **THEN** `config.json` shows `capacity` `{ value: 3, source: "argument" }`, the event log holds `operator.config` followed by `config.resolved`, and `status.config.capacity` agrees

#### Scenario: Record shows the kind and the Codex leaves
- **WHEN** `PUT /v1/config` sets `runnerKind` to `codex`
- **THEN** `config.json` shows `runnerKind` `{ value: "codex", source: "argument" }`, `model` `{ value: "gpt-6-astra", source: "default", applied: true }`, and a `codex` block with `sandbox` `{ value: "workspace-write", source: "default" }`

#### Scenario: Overrides survive a restart
- **WHEN** `checkCommand` was set through the route and the daemon is restarted without arguments
- **THEN** the effective check command is still the one set, with source `argument`

### Requirement: Runtime overrides and start-only keys
`checkCommand`, `capacity`, `allowedTools`, `runnerCommand`, `runnerKind`, `model`, `effort`, and the namespaced keys `claude.model`, `claude.effort`, `codex.model`, `codex.effort`, `codex.sandbox`, `codex.commit`, and `codex.command` SHALL be overridable while the daemon runs.

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
- **THEN** the response is 400 naming `effort` and the kind in force, and nothing changes

#### Scenario: Runner kind at runtime
- **WHEN** `PUT /v1/config` carries `runnerKind: "codex"`
- **THEN** the response is 200 with `applied: ["runnerKind"]`, and `{ runnerKind: "cursor" }` is refused with 400 naming `runnerKind`

#### Scenario: Flat model binds to the kind in force
- **WHEN** the kind in force is `claude-code`, the operator sets `model` to `claude-sonnet-5-5`, then sets `runnerKind` to `codex`
- **THEN** the stored document is `{ claude: { model: "claude-sonnet-5-5" }, runnerKind: "codex" }` and `config.model` is the Codex default

#### Scenario: Model applies to the next prepared launch
- **WHEN** T1's launch is parked claimable under `claude-opus-5-5` and the operator sets `model` to `claude-sonnet-5-5` before T2 is prepared
- **THEN** T1's claim response still says `claude-opus-5-5` and T2's launch has `claude-sonnet-5-5`

### Requirement: Runtime limit overrides
The launch time budget and the two stuck limits SHALL be durable runtime overrides, nested as in the configuration file: `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs`. The override document SHALL hold them as `{ budgets: { maxLaunchMs }, health: { stuckAfterMs, stuckFailAfterMs } }`, and `budgets` and `health` in an override SHALL accept no other leaf: every other key of those blocks stays a start-time key of the file.

#### Scenario: A raise is stored and survives a restart
- **WHEN** a patch sets `budgets: { maxLaunchMs: 40000 }` and a new daemon opens the same store
- **THEN** the configuration report gives `budgets.maxLaunchMs` as `{ value: 40000, source: "argument" }` and the new daemon's first tick measures launches against 40000

#### Scenario: Zero disables, null falls back
- **WHEN** a patch sets `health: { stuckFailAfterMs: 0 }` and a later patch sets `health: { stuckFailAfterMs: null }`
- **THEN** after the first the leaf is `{ value: 0, source: "argument" }` and no launch is failed for silence; after the second it is the file value with source `file`, or the default with source `default`

#### Scenario: Bad values are refused
- **WHEN** a patch gives `budgets.maxLaunchMs` as -1, 1.5, the string "5000" or a value above `Number.MAX_SAFE_INTEGER`, or names `health.reportGraceMs`
- **THEN** it is refused with 400 naming the dotted key, and nothing is stored

#### Scenario: Digits only from --set
- **WHEN** `--set budgets.maxLaunchMs=` is given with an empty value, `abc`, `1.5`, `-1`, `1e3` or `0x10`
- **THEN** it is a usage error, and an empty value never disables the limit

#### Scenario: The pair rule refuses a fail limit at or below the flag limit
- **WHEN** the file gives 900000 and 2700000 and a patch sets `health: { stuckFailAfterMs: 600000 }`
- **THEN** it is refused naming `health.stuckFailAfterMs`, and the message holds 600000 and 900000 with their sources

#### Scenario: The pair rule accepts a pair set together, or a disabled flag limit
- **WHEN** a patch sets `health: { stuckAfterMs: 300000, stuckFailAfterMs: 600000 }`, or `health: { stuckAfterMs: 0, stuckFailAfterMs: 600000 }`
- **THEN** it is accepted

#### Scenario: The pair rule is skipped for other keys
- **WHEN** the file sets only `health.stuckFailAfterMs: 600000` (below the default flag limit) and a patch sets `capacity: 3`, or the daemon starts with no patch
- **THEN** the patch is accepted and the daemon starts, logging one warning that names both values and their sources

## ADDED Requirements

### Requirement: Scalar and list-valued keys
A scalar key SHALL take the first layer that supplies it. A list-valued key (`allowedTools`) SHALL compose: the lists of every layer are concatenated in layer order and duplicates dropped.

#### Scenario: A rule added twice is kept once
- **WHEN** detection derives `Bash(make:*)` and `runner.claude.allowedTools` in the file also lists `Bash(make:*)`
- **THEN** the effective allow list holds `Bash(make:*)` once, after the base rules, in the `detected` part, and the `file` part does not repeat it

### Requirement: Provenance of resolved values
Every resolved value SHALL record its provenance as `argument`, `file`, `pinned`, `detected`, or `default`; a composed list SHALL record `composed` with the rules each layer contributed; a required key no layer supplies SHALL record `unresolved`. Only `checkCommand` can be unresolved: `integrationBranch` defaults to `main`, `capacity` to 2, `runnerCommand` to the default template, and `runnerKind` to `claude-code`.

#### Scenario: Only the check command is unresolved
- **WHEN** the daemon resolves a repository with no file, no argument, no recognised manifest and no remote, with `HEAD` detached
- **THEN** `checkCommand` has source `unresolved` and `needsConfig` is `["checkCommand"]`, while `integrationBranch` is `main`, `capacity` is 2 and `runnerKind` is `claude-code`, each with source `default`

### Requirement: Per-kind key resolution
A key held per runner kind (`model`, `effort`, and the `runner.codex` leaves) SHALL resolve from the block of the kind it belongs to, and its default SHALL be that kind's default; the flat `model` and `effort` SHALL report the kind in force.

#### Scenario: Flat model reports the kind in force
- **WHEN** the file sets `runner.kind: codex` and `runner.claude.model: claude-sonnet-5-5` and no Codex model
- **THEN** `model` is the Codex default `gpt-6-astra` with source `default`

### Requirement: Optional configuration file
`orchestrator.yaml` SHALL remain optional and SHALL keep its present meaning for every key it sets.

#### Scenario: Start without a file
- **WHEN** the daemon starts in a repository whose root has a `Makefile` with a `test` target and no `orchestrator.yaml`
- **THEN** it starts, with `checkCommand` `make test` from `detected`, `capacity` 2 from `default`, and `needsConfig` empty

### Requirement: Detection rows for Rust, Go and Python
At daemon start the daemon SHALL inspect the repository root, never subdirectories, against the table of "Toolchain detection" in its order and SHALL take the check command of the first row that matches, where these rows follow its `package.json` row: `Cargo.toml` gives `cargo test`; `go.mod` gives `go test ./...`; `pyproject.toml`, `setup.cfg`, or `pytest.ini` gives `uv run pytest` when `uv.lock` exists, else `poetry run pytest` when `poetry.lock` exists, else `pytest`.

#### Scenario: Python with Poetry
- **WHEN** the root has `setup.cfg` and `poetry.lock` and no `uv.lock`, and no earlier row matches
- **THEN** the detected check command is `poetry run pytest`

### Requirement: Detection rows for Ruby and Gradle
At daemon start the daemon SHALL inspect the repository root, never subdirectories, against the table of "Toolchain detection" in its order and SHALL take the check command of the first row that matches, where these rows follow the `pyproject.toml` row of "Detection rows for Rust, Go and Python": `Gemfile` gives `bundle exec rspec` when `.rspec` exists, else `bundle exec rake test`; `build.gradle` or `build.gradle.kts` gives `./gradlew test` when `gradlew` exists, else `gradle test`.

#### Scenario: Gradle with a wrapper
- **WHEN** the root has `build.gradle` and `gradlew`, and no earlier row matches
- **THEN** the detected check command is `./gradlew test`

### Requirement: Detection rows for Maven, Elixir and .NET
At daemon start the daemon SHALL inspect the repository root, never subdirectories, against the table of "Toolchain detection" in its order and SHALL take the check command of the first row that matches, where these rows follow the `build.gradle` row of "Detection rows for Ruby and Gradle": `pom.xml` gives `./mvnw -q test` when `mvnw` exists, else `mvn -q test`; `mix.exs` gives `mix test`; a `*.sln` or `*.csproj` file gives `dotnet test`.

#### Scenario: Maven with a wrapper
- **WHEN** the root has `pom.xml` and `mvnw`, and no earlier row matches
- **THEN** the detected check command is `./mvnw -q test`

### Requirement: Found toolchains
Every row whose manifest is present SHALL be recorded as a found toolchain whether or not it supplied the check command.

#### Scenario: A later row is found but supplies nothing
- **WHEN** the root has `Cargo.toml` and `go.mod`
- **THEN** the detected check command is `cargo test`, and the record lists `rust` and `go` as found with the manifests `Cargo.toml` and `go.mod`

### Requirement: Detection record contents
The detection record SHALL carry the toolchains found, the manifests that matched, the package manager when relevant, the check command or its absence, and one reason line per decision.

#### Scenario: Nothing recognised
- **WHEN** detection runs on a repository whose root has no recognised manifest
- **THEN** the record has no toolchain, no manifest and no check command, and its reasons hold a line saying no recognised manifest is in the repository root

### Requirement: Detection once per daemon start
Detection SHALL run once per daemon start and SHALL NOT be repeated while the daemon runs.

#### Scenario: A manifest added while the daemon runs
- **WHEN** a `package.json` with a test script is added to the root of a running daemon whose detection found nothing, and an override of `capacity` is then accepted
- **THEN** the configuration report still has `checkCommand` `unresolved` and no `node` toolchain, until the daemon is started again

### Requirement: Pinned branch beats detection
The pin SHALL beat detection and the default silently, so a moved `origin/HEAD` or a different branch checked out in the main checkout never changes a run's branch.

#### Scenario: Another branch checked out on an untouched run
- **WHEN** a run pinned `main` holds no launch and no job, and is started again with `trunk` checked out and no file or argument naming a branch
- **THEN** the integration branch is `main` with source `pinned`, and the pin is not rewritten

### Requirement: Explicit branch against the pin
Only an explicit layer that names a different branch (a `start` argument, a `--set` flag, or `orchestrator.yaml`) SHALL conflict with the pin: the daemon SHALL refuse to start when the store holds any launch or verifier job, logging both branches and that the run must keep its branch or start from a fresh run directory, and SHALL adopt the explicit branch and re-pin it together with `baselineHead` when the store holds neither.

#### Scenario: Explicit layer naming the pinned branch
- **WHEN** a run pinned `main` holds one launch and is started again with `--set integrationBranch=main`
- **THEN** the daemon starts, the integration branch is `main` with source `argument`, and the pin and `baselineHead` are unchanged

### Requirement: Integration branch in every runner mode
The integration branch SHALL apply in every runner mode.

#### Scenario: Pinned branch in pull mode
- **WHEN** a run pinned `develop` is started again with `--mode pull`
- **THEN** the integration branch is `develop` with source `pinned`, as in `spawn` mode

### Requirement: Derived rules for Node
When the runner kind in force is `claude-code`, the daemon SHALL derive the allow list for the agents it spawns from the toolchains found in the repository root: for a `node` toolchain with package manager `<pm>`, `Bash(<pm> test:*)`, `Bash(<pm> run:*)`, `Bash(<pm> install:*)`, `Bash(<pm> exec:*)`, `Bash(node:*)`, plus `Bash(npm ci:*)` and `Bash(npx:*)` for npm, `Bash(npx:*)` for pnpm and yarn, and `Bash(bunx:*)` for bun.

#### Scenario: pnpm rules derived
- **WHEN** the repository has `package.json` with a test script and `pnpm-lock.yaml`
- **THEN** the derived rules are `Bash(pnpm test:*)`, `Bash(pnpm run:*)`, `Bash(pnpm install:*)`, `Bash(pnpm exec:*)`, `Bash(node:*)`, and `Bash(npx:*)`, with no `Bash(npm ci:*)`

### Requirement: Derived rules for Rust, Go and Python
When the runner kind in force is `claude-code`, the daemon SHALL derive the allow list for the agents it spawns from the toolchains found in the repository root: for `rust`, `Bash(cargo:*)`; for `go`, `Bash(go:*)`; for `python`, `Bash(pytest:*)`, `Bash(python:*)`, `Bash(python3:*)`, `Bash(pip:*)`, plus `Bash(uv:*)` when `uv.lock` exists and `Bash(poetry:*)` when `poetry.lock` exists.

#### Scenario: Python with Poetry rules derived
- **WHEN** the repository has `pyproject.toml` and `poetry.lock`
- **THEN** the derived rules are `Bash(pytest:*)`, `Bash(python:*)`, `Bash(python3:*)`, `Bash(pip:*)`, and `Bash(poetry:*)`, with no `Bash(uv:*)`

### Requirement: Derived rules for Make, Ruby, Gradle, Maven, Elixir and .NET
When the runner kind in force is `claude-code`, the daemon SHALL derive the allow list for the agents it spawns from the toolchains found in the repository root: for `make`, `Bash(make:*)`; for `ruby`, `Bash(bundle:*)`, `Bash(rake:*)`, `Bash(rspec:*)`, `Bash(ruby:*)`; for `gradle`, `Bash(./gradlew:*)` and `Bash(gradle:*)`; for `maven`, `Bash(mvn:*)` and `Bash(./mvnw:*)`; for `elixir`, `Bash(mix:*)` and `Bash(elixir:*)`; for `dotnet`, `Bash(dotnet:*)`.

#### Scenario: Maven and Elixir rules derived
- **WHEN** the repository has `pom.xml` and `mix.exs`
- **THEN** the derived rules include `Bash(mvn:*)`, `Bash(./mvnw:*)`, `Bash(mix:*)`, and `Bash(elixir:*)`

### Requirement: Added allow-list rules
Rules from `runner.claude.allowedTools` in the file and from arguments SHALL be appended. `runner.claude.deriveTools: false` SHALL drop the toolchain rules and keep the base rules and the added ones.

#### Scenario: Derivation off with nothing added
- **WHEN** the file sets `runner.claude.deriveTools: false` in a Node repository and no file rule or argument adds a rule
- **THEN** the effective allow list is exactly the base rules

### Requirement: Unsafe allow-list rules
A rule containing a double quote, backslash, dollar sign, or backtick SHALL be rejected at configuration time.

#### Scenario: Rule with a dollar sign refused through the route
- **WHEN** `PUT /v1/config` carries `allowedTools: ["Bash(echo $HOME)"]`
- **THEN** the response is 400 naming `allowedTools` and nothing is stored

### Requirement: Allow list beside the repository settings
The list SHALL be passed as `--allowedTools`, which adds a source of approval beside the repository's own `.claude/settings.json` and `.claude/settings.local.json` rules and never replaces them; a deny rule in those files wins over the list, as Claude Code evaluates deny before allow at every level.

#### Scenario: Default template passes the list as a flag
- **WHEN** a launch is spawned with the default Claude Code template
- **THEN** its command passes the list after `--allowedTools`, and carries neither `--settings` nor `--dangerously-skip-permissions`

### Requirement: Allow list only for spawned launches
The derived list SHALL apply only to launches the daemon spawns (`spawn` mode, and `mixed` mode once the claim window elapses); a launch a worker claims runs under the worker's own permissions and SHALL NOT be given the list. The plugin's default mode and the work workflow are decided by the sibling change `add-daemon-lifecycle`, not here.

#### Scenario: Unclaimed launch spawned in mixed mode
- **WHEN** in `mixed` mode a parked launch is not claimed within the claim window and the daemon spawns it under `claude-code`
- **THEN** the command the runner composes for it carries the effective allow list in its `{allowedTools}` slot

### Requirement: No allow list under Codex or OpenCode
Allow-list composition is specific to `claude-code`: when the kind in force is `codex` or `opencode`, `config.allowedTools` SHALL be `{ value: [], source: "composed", applied: false }` with empty parts, and the runner's own policies apply instead (see worker-runners).

#### Scenario: No list under OpenCode
- **WHEN** the file sets `runner.kind: opencode` in a Node repository
- **THEN** `config.allowedTools` has `value: []`, empty parts, and `applied: false`

### Requirement: Derived rules in the OpenCode permission ruleset
The derived `Bash(...)` rules SHALL also feed the OpenCode permission ruleset under `runner.opencode.permission: derived`: `Bash(x:*)` becomes the bash pattern `"x *"` and `Bash(x)` becomes `"x"` (see worker-runners "OpenCode runner command composition").

#### Scenario: Rules other than Bash give no pattern
- **WHEN** the rules `Bash(git:*)`, `mcp__orchestrator__heartbeat`, `Bash(npm test:*)`, and `Bash(git status)` are mapped to bash patterns
- **THEN** the patterns are `git *`, `npm test *`, and `git status`, and `mcp__orchestrator__heartbeat` gives none

### Requirement: Claude Code runner slot substitution
At every spawn the Claude Code runner SHALL substitute:
- `{allowedTools}` with the effective allow list, each rule double-quoted and space-separated;
- `{model}` and `{effort}` with the launch's model and effort;
- the existing `{brief}`, `{worktree}`, `{launchId}`, and `{mcpConfig}`.

#### Scenario: Rules quoted into the slot
- **WHEN** a launch is spawned with the default Claude Code template and the allow list `Bash(git:*)` and `Bash(npm test:*)`
- **THEN** the command carries `--allowedTools "Bash(git:*)" "Bash(npm test:*)"`, and the MCP config path and the brief path in place of `{mcpConfig}` and `{brief}`

### Requirement: Codex command template
`DEFAULT_CODEX_COMMAND` SHALL carry `{model}`, `{effort}`, `{sandbox}`, `{ephemeral}`, `{ignoreUserConfig}`, and `{codexOverrides}` and no `{allowedTools}` (see worker-runners "Codex runner command composition"). The Codex runner SHALL fill these slots at every spawn alongside the common ones.

#### Scenario: Codex slots of its own
- **WHEN** `DEFAULT_CODEX_COMMAND` is read
- **THEN** it carries `{sandbox}`, `{ephemeral}`, `{ignoreUserConfig}`, and `{codexOverrides}` besides `{model}` and `{effort}`, and no `{allowedTools}`

### Requirement: OpenCode command template
`DEFAULT_OPENCODE_COMMAND` SHALL carry `{pure}`, `{model}`, and `{variant}` (which carries the effort as `--variant <effort>`) and no `{allowedTools}`; its permissions travel in the per-launch config instead (see worker-runners "OpenCode runner command composition"). `hasEffortSlot` SHALL recognise `{effort}` or `{variant}`.

#### Scenario: Variant slot counts as the effort slot
- **WHEN** a template carries `{variant}` and no `{effort}`
- **THEN** `hasEffortSlot` is true for it

### Requirement: Composition through the compose hook
A runner with slots of its own SHALL compose the whole command through the subprocess runner's `compose` hook (the Codex runner's `composeCodexCommand`, shared with the Codex work loop); the subprocess runner itself substitutes only the common slots and the allow list. Substitution SHALL be one pass over the template with `\{(\w+)\}`, so a substituted value, such as a TOML inline table, is never re-substituted.

#### Scenario: Substituted value not re-substituted
- **WHEN** a slot is filled with a TOML inline table that itself contains text in braces, such as `{model}`
- **THEN** the composed command carries that text unchanged

### Requirement: Runner command from the file or an argument
A `runnerCommand` (or `runner.codex.command`) from the file or an argument that contains a slot SHALL be filled the same way. One without a slot SHALL run verbatim for that slot, and the configuration record SHALL mark the corresponding key as not applied.

#### Scenario: Slot-less command run verbatim
- **WHEN** the runner command carries `{launchId}` and no `{allowedTools}` slot, and a launch is spawned with a non-empty allow list
- **THEN** the command run has the launch id in place of `{launchId}` and carries no allow-list rule

### Requirement: Runner command read at spawn time
The composed command SHALL be read at spawn time, so a change to the list or the template reaches every launch spawned afterwards and no launch already live.

#### Scenario: Allow list read from the getter at each spawn
- **WHEN** the allow list the subprocess runner reads changes between two spawns
- **THEN** the second spawn's command carries the changed list and the first spawn's process keeps its own

### Requirement: Configuration record contents
The resolved configuration record SHALL carry the resolution time, the repository path, every configuration key with its value and source (nested blocks per leaf; `runnerKind`; `allowedTools` with its parts and whether it is applied), the detection record under `toolchain`, the overrides in force, and `needsConfig`: the keys whose value is `unresolved`.

#### Scenario: Record lists the allow list parts
- **WHEN** the daemon starts in a repository with a `Makefile` that has a `test` target
- **THEN** `config.json` holds `repo`, `resolvedAt`, `config.allowedTools` with its `parts` and `applied`, `toolchain` naming `make`, the overrides in force, and an empty `needsConfig`

### Requirement: Model and effort in the configuration record
The resolved configuration record SHALL carry every configuration key with its value and source (`model` and `effort` of the kind in force, each with whether it is applied, which for `claude-code` is whether `runnerCommand` carries the slot and for `codex` is true while `runner.codex.command` is unset, as the runner's built-in template carries the slots, and otherwise whether that command carries it).

#### Scenario: Applied follows the slot
- **WHEN** the daemon starts under `claude-code` with a `runnerCommand` argument that carries no `{model}` or `{effort}` slot
- **THEN** `config.json` gives `model` and `effort` with `applied: false`

### Requirement: Codex leaves in the configuration record
The resolved configuration record SHALL carry every configuration key with its value and source (the `codex` leaves `model`, `effort`, `command`, `sandbox`, `commit`, `networkAccess`, `ignoreUserConfig`, and `ephemeral`, whichever kind is in force).

#### Scenario: Codex leaves under Claude Code
- **WHEN** the daemon starts with the kind `claude-code` in force
- **THEN** the record still holds a `codex` block whose `sandbox` is `{ value: "workspace-write", source: "default" }`

### Requirement: Configuration record is informational
`config.json` SHALL be informational: `status` SHALL compute the same facts live and never read `config.json`.

#### Scenario: Status without the file
- **WHEN** `config.json` is removed from the run directory of a running daemon
- **THEN** `GET /v1/status` still reports `config` and `needsConfig`, computed from the store and the start's resolution

### Requirement: Configuration resolved event
The daemon SHALL append a `config.resolved` event with the provenance and detection summary at every start and after every accepted override.

#### Scenario: Event at start
- **WHEN** the daemon starts
- **THEN** the event log holds a `config.resolved` event whose payload carries `checkCommand` with its source, `toolchain` with the kinds found, and `needsConfig`

### Requirement: When a runtime override applies
A runtime override of `checkCommand` SHALL apply to every verifier job that starts checking after the change, `capacity` to the next admission pass, `allowedTools` and `runnerCommand` to every launch spawned after the change, and `runnerKind`, `model`, `effort`, and the namespaced keys to every launch prepared after the change.

#### Scenario: Allowed tools apply to the next spawn
- **WHEN** an argument rule is added through the configuration route while a launch is live
- **THEN** the next launch spawned carries the rule, and the live launch's command is unchanged

### Requirement: Per-kind override document
The override document SHALL keep model and effort per kind, nested as `{ claude: { model, effort }, codex: { model, effort, sandbox, commit, command } }`; a flat `model` or `effort` SHALL bind when it is written to the kind in force, or to a `runnerKind` in the same patch; a `--set` flag MAY name a namespaced key with a dot (`--set codex.model=gpt-6-pro`), and the configuration route accepts the nested form directly.

#### Scenario: Flat model binds to the kind in the same patch
- **WHEN** the kind in force is `claude-code` and a patch carries `runnerKind: "codex"` and `model: "gpt-6-pro"`
- **THEN** the stored document holds `codex: { model: "gpt-6-pro" }` and no flat `model`

### Requirement: Flat model and effort in an old override document
A stored document holding a flat `model` or `effort`, written before runner kinds, SHALL be read as `claude.*`.

#### Scenario: Old document read under claude
- **WHEN** the store's override document is `{ "model": "claude-sonnet-5-5" }`
- **THEN** it is read as `{ claude: { model: "claude-sonnet-5-5" } }`

### Requirement: Start-only integration branch
`integrationBranch` SHALL be start-only: it is accepted as a `start` argument that spawns the daemon, subject to pinning, and refused with 409 naming it as start-only on a running daemon. A request that mixes a start-only key with other keys SHALL be refused whole and apply nothing.

#### Scenario: Integration branch as a start argument
- **WHEN** a new run is started with `--set integrationBranch=develop` and `develop` exists
- **THEN** the integration branch is `develop` with source `argument`, and `develop` is pinned in the store

### Requirement: Clearing an override with null
Setting a key to null SHALL clear its override so the value falls back to the next layer; a null for one namespaced leaf (`codex: { model: null }`) SHALL clear only that leaf.

#### Scenario: Null clears one namespaced leaf
- **WHEN** overrides set `codex.effort` to `ultra` and `codex.sandbox` to `read-only`, and a patch carries `codex: { sandbox: null }`
- **THEN** `codex.sandbox` falls back to `workspace-write` with source `default`, and `codex.effort` stays `ultra` with source `argument`

### Requirement: Runtime override values
`capacity` SHALL be a positive integer, `checkCommand`, `runnerCommand`, and `codex.command` non-empty strings, `allowedTools` a list of safe rules, `runnerKind` one of `claude-code` and `codex`.

#### Scenario: Empty check command refused
- **WHEN** `PUT /v1/config` carries `capacity: 3` and `checkCommand: ""`
- **THEN** the response is 400 naming `checkCommand` and the capacity is unchanged

### Requirement: Runtime override values for Codex, effort and model
`codex.sandbox` SHALL be one of `read-only`, `workspace-write`, `danger-full-access`, `codex.commit` one of `agent` and `daemon`, `effort` one of the levels of the kind it binds to (see worker-runners "Per-kind effort sets"), with the refusal naming the kind, and `model` a string matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`.

#### Scenario: Model outside the pattern refused
- **WHEN** `PUT /v1/config` carries `model: "opus; rm -rf /"`
- **THEN** the response is 400 naming `model` and nothing is stored

### Requirement: Runtime override value refusal
A value of an overridable key outside its rule in "Runtime override values" or "Runtime override values for Codex, effort and model" SHALL be refused with 400 naming the key.

#### Scenario: Unknown runner kind refused
- **WHEN** `PUT /v1/config` carries `runnerKind: "cursor"`
- **THEN** the response is 400 naming `runnerKind` and nothing is stored

### Requirement: Runtime limit values
A value SHALL be an integer from 0 to `Number.MAX_SAFE_INTEGER`; 0 SHALL disable the limit. A null leaf SHALL clear that override, and a null block SHALL clear every leaf of the block, so the value falls back to the file, else to the default. Any other value SHALL be refused naming the dotted key.

#### Scenario: Null block clears both stuck limits
- **WHEN** patches set `health: { stuckAfterMs: 0, stuckFailAfterMs: 0 }` and then `health: null` on a run with no file
- **THEN** both `health` leaves fall back to their defaults with source `default`, and the override document holds no `health` block

### Requirement: Runtime limits from --set
`--set` SHALL read the three values as decimal digits only, and SHALL also take `budgets=` and `health=` as a JSON object.

#### Scenario: A limit block as JSON
- **WHEN** the daemon is started with `--set 'health={"stuckAfterMs":0}'` and `--set budgets.maxLaunchMs=60000`
- **THEN** the override document holds `health: { stuckAfterMs: 0 }` and `budgets: { maxLaunchMs: 60000 }`

### Requirement: Stuck limit pair rule
Pair rule: a patch that touches `health.stuckAfterMs` or `health.stuckFailAfterMs` (a null leaf or a null `health` block counts) SHALL be refused when the pair in force after it would have both values above 0 and `health.stuckFailAfterMs` not above `health.stuckAfterMs`. Both keys MAY be set in one patch. The refusal SHALL name `health.stuckFailAfterMs` when the patch touches it, else `health.stuckAfterMs`, and its message SHALL give both keys, both values and the source of each.

#### Scenario: Flag limit raised to the fail limit
- **WHEN** the pair in force is 900000 and 2700000 from the defaults and a patch sets `health: { stuckAfterMs: 2700000 }`
- **THEN** it is refused naming `health.stuckAfterMs`, and the message holds 2700000 twice with the sources `argument` and `default`

### Requirement: Stuck limit pair rule outside a patch of the pair
The rule SHALL NOT be evaluated for a patch that touches neither key, so a file whose own pair breaks it still starts and still takes a patch of another key. At start, when the pair in force breaks the rule, the daemon SHALL log one warning naming both values and their sources, and SHALL NOT refuse to start.

#### Scenario: Patch of the budget beside a breaking pair
- **WHEN** the file gives `health.stuckAfterMs: 900000` and `health.stuckFailAfterMs: 600000` and a patch sets `budgets: { maxLaunchMs: 60000 }`
- **THEN** the patch is accepted

### Requirement: When a runtime limit change applies
A change SHALL apply on the next tick to every live launch, to claims made afterwards, and to `status`, as health-monitoring "Limits read at every check" states; a lowering is not refused for being a lowering, but a change that would end a live launch is refused with 409 unless confirmed, as operator-control "Configuration route: a change that would end a live launch" states.

#### Scenario: A change that would end a live launch
- **WHEN** T1's launch is live and `PUT /v1/config` sets `budgets: { maxLaunchMs: 1 }` without `endLive`
- **THEN** the response is 409 with `wouldEnd` naming T1's launch and `budgets.maxLaunchMs`, and nothing is stored

### Requirement: Unknown keys in a stored override document
A stored document with a key the reader does not know SHALL be read as empty, as before.

#### Scenario: Stored document with a future key
- **WHEN** the store's override document is `{ "capacity": 3, "futureKey": 1 }`
- **THEN** it is read as empty and `capacity` falls back to the file or the default
