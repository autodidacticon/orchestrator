## MODIFIED Requirements

### Requirement: Codex host
`hosts/codex/` SHALL let a Codex session be the operator. It SHALL ship `bin/orchestrator.mjs`, the dependency-free launcher of "Plugin launcher" resolving its host directory from its own URL, whose npx fallback is pinned to the version of the published package in `hosts/codex/package.json`. It SHALL NOT read `.claude-plugin/plugin.json`. `hosts/codex/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/codex/node_modules` SHALL be ignored by git.

`hosts/codex/` SHALL be installable as the Codex plugin of "Codex plugin manifest". `hosts/codex/config.toml` SHALL be the manual registration template. It SHALL declare `[mcp_servers.orchestrator_operator]` with `command = "node"`, `args` set to the launcher and `mcp`, `startup_timeout_sec = 30`, and a `tool_timeout_sec` of at least `ceil(WAIT_CAP_MS / 1000) + 30`. The id SHALL use an underscore, so the tools are `mcp__orchestrator_operator__<tool>`.

`hosts/codex/README.md` SHALL lead with the plugin install: `codex plugin marketplace add autodidacticon/orchestrator` and `codex plugin add orchestrator-codex@orchestrator`. It SHALL say that the plugin's operator server runs in the plugin root, so the tools take `repo` and the skills pass it, and SHALL document the approval keys `codex exec` needs for a plugin's server, under `plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator`. It SHALL tell users who have `orchestrator@orchestrator` installed in Codex to remove it with `codex plugin remove orchestrator@orchestrator`. It SHALL keep the template block as the manual alternative, and `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/codex>/bin/orchestrator.mjs mcp` as the alternative for a registration that keeps Codex's 60-second default tool timeout. It SHALL document verification with `codex mcp get orchestrator_operator`, and the approval keys `codex exec` needs for a manually registered server.

`hosts/codex/skills/` SHALL hold `import`, `run`, and `review` skills, named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`, with the behaviour of "Skills" except as follows. They SHALL NOT reference `${CLAUDE_PLUGIN_ROOT}`. They SHALL have no Workflow or subagent section and SHALL name no Claude model as a default. They SHALL look for the test command in `AGENTS.md`, with `CLAUDE.md` only as the fallback when there is no `AGENTS.md`. Their toolchain line SHALL always name the runner kind. They SHALL pass `repo` on every operator call, as "Skills pass the repository" defines. When no daemon is running and `orchestrator.yaml` sets no `runner.mode`, they SHALL call `start` with `mode: "spawn"`, so that the daemon runs the agents headless; otherwise they SHALL call `start` without `mode`, because an explicit mode overrides the file and is applied to a running daemon. When the mode in force is `pull` or `mixed` they SHALL say so, SHALL name the work loop (`orchestrator-work`, "Work loop by runner kind") as the way codex launches are worked in those modes, and SHALL offer `spawn` unless another session holds launches of the run. They SHALL say that under `codex exec` the operator tools run only when approvals are pre-granted (`approval_policy = "never"`, `default_tools_approval_mode = "approve"`, and per-tool `approval_mode = "approve"`), and that an interactive session prompts instead. The `import` skill SHALL name the Codex form of the tracker connectors' tools (`mcp__linear__`, `mcp__atlassian__`).

#### Scenario: operator server registers and its tools answer in a Codex session
- **WHEN** `codex exec` runs with `mcp_servers.orchestrator_operator` set as in `hosts/codex/config.toml` and every operator tool pre-approved, and is asked to start a run, import a graph of scripted tasks, answer its question, and wait
- **THEN** its `mcp_tool_call` items name server `orchestrator_operator`, `start` reports mode `spawn`, and a `wait` result reports `finished: true`

#### Scenario: Registration verified
- **WHEN** the template block is in a Codex config and `codex mcp get orchestrator_operator` is run
- **THEN** it lists the server as enabled over stdio with command `node`, the launcher and `mcp` as args, `startup_timeout_sec: 30`, and a `tool_timeout_sec` above the `wait` cap by at least thirty seconds

#### Scenario: Launcher pinned by the host package
- **WHEN** `hosts/codex` is copied outside any checkout without `node_modules` and its launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp`
- **THEN** it prints source `npx` with `--package=<name>@<the version in hosts/codex/package.json>` and `orchestrator-mcp`

#### Scenario: Test command from AGENTS.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` in a Codex session and `AGENTS.md` says "run tests with `make check`"
- **THEN** the `orchestrator-run` skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `AGENTS.md`

#### Scenario: README leads with the plugin
- **WHEN** the host tests read `hosts/codex/README.md`
- **THEN** it names `codex plugin add orchestrator-codex@orchestrator` before the `[mcp_servers.orchestrator_operator]` template block, names `codex plugin remove orchestrator@orchestrator`, and no longer says that Codex has no plugin manifest

## ADDED Requirements

### Requirement: Codex plugin manifest
`hosts/codex/` SHALL be the Codex plugin `orchestrator-codex`. `hosts/codex/.codex-plugin/plugin.json` SHALL name it `orchestrator-codex`, SHALL carry a `version` equal to the package version, and SHALL point `skills` at `./skills/`, `mcpServers` at `./.mcp.json`, and `hooks` at `./hooks/hooks.json`. A host test SHALL parse the manifest and SHALL fail when its version differs from the package version.

#### Scenario: Plugin version follows the package
- **WHEN** a release bumps `package.json` without `hosts/codex/.codex-plugin/plugin.json`
- **THEN** the host test fails

### Requirement: Codex plugin hooks
`hosts/codex/hooks/hooks.json` SHALL run `hooks/session-start.mjs` (matcher `startup|resume|clear`, ten-second timeout) on `SessionStart` and `hooks/session-end.mjs` on `SessionEnd`, each with `node` through `${PLUGIN_ROOT}`.

#### Scenario: Hooks parse
- **WHEN** the host tests read `hosts/codex/hooks/hooks.json`
- **THEN** it declares exactly the two hooks, each command naming its script under `${PLUGIN_ROOT}/hooks/`

### Requirement: Codex marketplace file
The repository SHALL contain `.agents/plugins/marketplace.json` at its root, named `orchestrator`, listing only `orchestrator-codex` with `source: { source: "local", path: "./hosts/codex" }`, `policy.installation: "AVAILABLE"`, and category `Developer Tools`. Codex reads this file instead of `.claude-plugin/marketplace.json`, which SHALL keep listing the Claude Code plugin for Claude Code.

#### Scenario: Installed from the marketplace file
- **WHEN** `codex plugin marketplace add <checkout>` runs in a scratch `CODEX_HOME`
- **THEN** `codex plugin list` lists `orchestrator-codex@orchestrator` and no other plugin of that marketplace, and `codex plugin add orchestrator-codex@orchestrator` installs it

### Requirement: Codex plugin MCP server
`hosts/codex/.mcp.json` SHALL declare exactly one server, `orchestrator_operator`, with `command: "node"`, `args: ["./bin/orchestrator.mjs", "mcp"]`, and `cwd: "."`, because Codex resolves `cwd: "."` to the installed plugin root and expands no variable in `args`. It SHALL set `startup_timeout_sec: 60` (a first start may fetch through npx), `tool_timeout_sec` above `WAIT_CAP_MS / 1000 + 30` (180), and `env_vars` forwarding `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, and `ORCH_REPO`.

#### Scenario: Server runs from the plugin root
- **WHEN** the plugin is installed and `codex mcp get orchestrator_operator --json` is run
- **THEN** its `cwd` is the installed plugin root, its args are `./bin/orchestrator.mjs` and `mcp`, `startup_timeout_sec` is 60, and `tool_timeout_sec` is 180

#### Scenario: Start through the plugin names the repository
- **WHEN** the installed plugin's launcher runs this checkout's build, its tools are pre-approved under the plugin's key, and `codex exec -C <throwaway repository>` is asked to call `start` with `repo` set to that repository
- **THEN** the `start` call's arguments carry the repository and its result has status 200 and names the repository

### Requirement: Skills pass the repository
The `import`, `run`, and `review` skills of the Codex and OpenCode hosts SHALL tell the model to pass `repo`, the absolute path of the session's working directory, on every operator tool call, because a plugin-installed operator server runs in the plugin's directory and cannot tell the session's project. The instruction SHALL be one paragraph, identical in both editions after the OpenCode substitutions.

#### Scenario: Codex skills pass repo
- **WHEN** the host tests read each Codex skill
- **THEN** it says to pass `repo`, set to the absolute path of this session's working directory, on every operator tool call

#### Scenario: OpenCode edition unchanged otherwise
- **WHEN** the OpenCode host test compares each OpenCode skill with its Codex edition
- **THEN** the `repo` paragraph matches block for block, and only the pinned edition blocks differ
