# Toolchain Discovery Specification

## Purpose
How the daemon works out a run's configuration without requiring an `orchestrator.yaml`: the resolution order (argument, file, pinned branch, detection, default) and the provenance every resolved value records, including `unresolved` for a check command no layer supplies; the detection table that inspects the repository root once per daemon start, its fixed precedence, and the Node package manager selection; integration branch detection from `origin/HEAD` or the current branch and the pin that keeps a run on the branch it first used; the allow list derived from the toolchains found, composed with the rules the file and arguments add, and passed only to launches the daemon spawns; the `{allowedTools}` slot through which the runner command is composed at every spawn; the resolved configuration record written as `config.json` beside `daemon.json` and the `config.resolved` event; and the runtime override rules under which `checkCommand`, `capacity`, `allowedTools`, and `runnerCommand` change without a restart while `integrationBranch` stays start-only.

## Requirements

### Requirement: Resolution order and provenance
Every configurable value SHALL be resolved from four layers in this order: an explicit argument (a `start` argument, an `orchestrator-ctl start --set` flag, or a daemon `--set key=value` flag, each stored as a durable override for the run), then `<repo>/orchestrator.yaml` when the file is present and names the key, then, for `integrationBranch` only, the branch pinned in the store for the run, then detection from the repository, then the built-in default. A scalar key SHALL take the first layer that supplies it. A list-valued key (`allowedTools`) SHALL compose: the lists of every layer are concatenated in layer order and duplicates dropped. Every resolved value SHALL record its provenance as `argument`, `file`, `pinned`, `detected`, or `default`; a composed list SHALL record `composed` with the rules each layer contributed; a required key no layer supplies SHALL record `unresolved`. Only `checkCommand` can be unresolved: `integrationBranch` defaults to `main`, `capacity` to 2, and `runnerCommand` to the default template. `orchestrator.yaml` SHALL remain optional and SHALL keep its present meaning for every key it sets.

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

### Requirement: Toolchain detection
At daemon start the daemon SHALL inspect the repository root, never subdirectories, against this table in this order and SHALL take the check command of the first row that matches: a `Makefile` (or `GNUmakefile`, `makefile`) containing a line that defines a `test` target gives `make test`; a `package.json` whose `scripts.test` is a non-empty string other than npm's placeholder (`echo "Error: no test specified" && exit 1`) gives `<pm> test` with the package manager chosen as specified below; `Cargo.toml` gives `cargo test`; `go.mod` gives `go test ./...`; `pyproject.toml`, `setup.cfg`, or `pytest.ini` gives `uv run pytest` when `uv.lock` exists, else `poetry run pytest` when `poetry.lock` exists, else `pytest`; `Gemfile` gives `bundle exec rspec` when `.rspec` exists, else `bundle exec rake test`; `build.gradle` or `build.gradle.kts` gives `./gradlew test` when `gradlew` exists, else `gradle test`; `pom.xml` gives `./mvnw -q test` when `mvnw` exists, else `mvn -q test`; `mix.exs` gives `mix test`; a `*.sln` or `*.csproj` file gives `dotnet test`. Every row whose manifest is present SHALL be recorded as a found toolchain whether or not it supplied the check command. The detection record SHALL carry the toolchains found, the manifests that matched, the package manager when relevant, the check command or its absence, and one reason line per decision. Detection SHALL run once per daemon start and SHALL NOT be repeated while the daemon runs.

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

### Requirement: Node package manager selection
For a `package.json` the package manager SHALL be the one named by its `packageManager` field when present (`npm`, `pnpm`, `yarn`, or `bun`, with any version suffix ignored); otherwise `pnpm` when `pnpm-lock.yaml` exists, `yarn` when `yarn.lock` exists, `bun` when `bun.lock` or `bun.lockb` exists, and `npm` otherwise, checked in that order.

#### Scenario: packageManager field wins
- **WHEN** `package.json` declares `"packageManager": "yarn@4.1.0"` and `package-lock.json` exists
- **THEN** the package manager is `yarn` and the check command is `yarn test`

#### Scenario: Lockfile decides
- **WHEN** `package.json` has no `packageManager` field and `bun.lockb` exists
- **THEN** the package manager is `bun` and the check command is `bun test`

#### Scenario: npm by default
- **WHEN** `package.json` has a test script and no lockfile exists
- **THEN** the package manager is `npm`

### Requirement: Integration branch detection and pinning
When neither an argument nor the file sets `integrationBranch`, the daemon SHALL use the branch pinned in the store for the run when one is recorded, with provenance `pinned`; otherwise it SHALL detect the branch that `refs/remotes/origin/HEAD` points at when that symbolic ref exists and the branch exists locally as `refs/heads/<name>`, else the branch `HEAD` is on when it is on a branch, else `main`, and SHALL pin the result in the store together with `baselineHead`. The pin SHALL beat detection and the default silently, so a moved `origin/HEAD` or a different branch checked out in the main checkout never changes a run's branch. Only an explicit layer that names a different branch (a `start` argument, a `--set` flag, or `orchestrator.yaml`) SHALL conflict with the pin: the daemon SHALL refuse to start when the store holds any launch or verifier job, logging both branches and that the run must keep its branch or start from a fresh run directory, and SHALL adopt the explicit branch and re-pin it together with `baselineHead` when the store holds neither. The integration branch SHALL apply in every runner mode.

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
The daemon SHALL derive the allow list for the agents it spawns from the toolchains found in the repository root: the base rules `Bash(git:*)`, `mcp__orchestrator__heartbeat`, `mcp__orchestrator__report`, `mcp__orchestrator__block`, `mcp__orchestrator__inbox`, and `mcp__orchestrator__log` always; for a `node` toolchain with package manager `<pm>`, `Bash(<pm> test:*)`, `Bash(<pm> run:*)`, `Bash(<pm> install:*)`, `Bash(<pm> exec:*)`, `Bash(node:*)`, plus `Bash(npm ci:*)` and `Bash(npx:*)` for npm, `Bash(npx:*)` for pnpm and yarn, and `Bash(bunx:*)` for bun; for `rust`, `Bash(cargo:*)`; for `go`, `Bash(go:*)`; for `python`, `Bash(pytest:*)`, `Bash(python:*)`, `Bash(python3:*)`, `Bash(pip:*)`, plus `Bash(uv:*)` when `uv.lock` exists and `Bash(poetry:*)` when `poetry.lock` exists; for `make`, `Bash(make:*)`; for `ruby`, `Bash(bundle:*)`, `Bash(rake:*)`, `Bash(rspec:*)`, `Bash(ruby:*)`; for `gradle`, `Bash(./gradlew:*)` and `Bash(gradle:*)`; for `maven`, `Bash(mvn:*)` and `Bash(./mvnw:*)`; for `elixir`, `Bash(mix:*)` and `Bash(elixir:*)`; for `dotnet`, `Bash(dotnet:*)`. Rules from `runner.claude.allowedTools` in the file and from arguments SHALL be appended. `runner.claude.deriveTools: false` SHALL drop the toolchain rules and keep the base rules and the added ones. A rule containing a double quote, backslash, dollar sign, or backtick SHALL be rejected at configuration time. The list SHALL be passed as `--allowedTools`, which adds a source of approval beside the repository's own `.claude/settings.json` and `.claude/settings.local.json` rules and never replaces them; a deny rule in those files wins over the list, as Claude Code evaluates deny before allow at every level. The derived list SHALL apply only to launches the daemon spawns (`spawn` mode, and `mixed` mode once the claim window elapses); a launch a worker claims runs under the worker's own permissions and SHALL NOT be given the list. The plugin's default mode and the work workflow are decided by the sibling change `add-daemon-lifecycle`, not here.

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

### Requirement: Runner command composition
`DEFAULT_CLAUDE_COMMAND` SHALL be a template with an `{allowedTools}` slot in place of the fixed `--allowedTools` list. At every spawn the Claude Code runner SHALL substitute `{allowedTools}` with the effective allow list, each rule double-quoted and space-separated, alongside the existing `{brief}`, `{worktree}`, `{launchId}`, and `{mcpConfig}` substitutions. A `runnerCommand` from the file or an argument that contains the slot SHALL be filled the same way; one without the slot SHALL run verbatim, and the configuration record SHALL mark the allow list as not applied. The composed command SHALL be read at spawn time, so a change to the list or the template reaches every launch spawned afterwards and no launch already live.

#### Scenario: Default template filled
- **WHEN** a launch is spawned in a Node repository with no file
- **THEN** the command run contains `--allowedTools "Bash(git:*)" "mcp__orchestrator__heartbeat" "mcp__orchestrator__report" "mcp__orchestrator__block" "mcp__orchestrator__inbox" "mcp__orchestrator__log" "Bash(npm test:*)"` followed by the remaining node rules

#### Scenario: Verbatim command without the slot
- **WHEN** the file sets `runnerCommand` to a command with its own fixed `--allowedTools` list and no `{allowedTools}`
- **THEN** that command runs unchanged and `config.allowedTools.applied` is false

#### Scenario: Later launches pick up a change
- **WHEN** `Bash(docker:*)` is added through the configuration route while T1's agent is live and T2 is launched afterwards
- **THEN** T2's command contains `Bash(docker:*)` and T1's process is unchanged

### Requirement: Resolved configuration record
The daemon SHALL keep the operator overrides durable in the store under one document and SHALL write the resolved configuration to `<runDir>/config.json` beside `daemon.json`, atomically, at every start and after every accepted override. The record SHALL carry the resolution time, the repository path, every configuration key with its value and source (nested blocks per leaf; `allowedTools` with its parts and whether it is applied), the detection record under `toolchain`, the overrides in force, and `needsConfig`: the keys whose value is `unresolved`. The file SHALL be informational: `status` SHALL compute the same facts live and never read the file. The daemon SHALL append a `config.resolved` event with the provenance and detection summary at every start and after every accepted override.

#### Scenario: Record written at start
- **WHEN** the daemon starts in a Node repository without a file
- **THEN** `config.json` exists in the run directory with `checkCommand` `{ value: "npm test", source: "detected" }`, `capacity` `{ value: 2, source: "default" }`, a `toolchain` block naming `node`, and an empty `needsConfig`

#### Scenario: Record follows an override
- **WHEN** `PUT /v1/config` sets `capacity` to 3
- **THEN** `config.json` shows `capacity` `{ value: 3, source: "argument" }`, the event log holds `operator.config` followed by `config.resolved`, and `status.config.capacity` agrees

#### Scenario: Overrides survive a restart
- **WHEN** `checkCommand` was set through the route and the daemon is restarted without arguments
- **THEN** the effective check command is still the one set, with source `argument`

### Requirement: Runtime overrides and start-only keys
`checkCommand`, `capacity`, `allowedTools`, and `runnerCommand` SHALL be overridable while the daemon runs: `checkCommand` applies to every verifier job that starts checking after the change, `capacity` to the next admission pass, and `allowedTools` and `runnerCommand` to every launch spawned after the change. `integrationBranch` SHALL be start-only: it is accepted as a `start` argument that spawns the daemon, subject to pinning, and refused with 409 naming it as start-only on a running daemon. Setting a key to null SHALL clear its override so the value falls back to the next layer. A request that mixes a start-only key with other keys SHALL be refused whole and apply nothing. `capacity` SHALL be a positive integer, `checkCommand` and `runnerCommand` non-empty strings, and `allowedTools` a list of safe rules; anything else SHALL be refused with 400 naming the key.

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
