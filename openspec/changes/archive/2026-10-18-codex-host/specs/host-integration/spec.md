## ADDED Requirements

### Requirement: Codex host
`hosts/codex/` SHALL let a Codex session be the operator. It SHALL ship `bin/orchestrator.mjs`, the dependency-free launcher of "Plugin launcher" resolving its host directory from its own URL, whose npx fallback is pinned to the version of the published package in `hosts/codex/package.json`. It SHALL NOT read `.claude-plugin/plugin.json`. `hosts/codex/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/codex/node_modules` SHALL be ignored by git.

`hosts/codex/config.toml` SHALL be the registration template. It SHALL declare `[mcp_servers.orchestrator_operator]` with `command = "node"`, `args` set to the launcher and `mcp`, `startup_timeout_sec = 30`, and a `tool_timeout_sec` of at least `ceil(WAIT_CAP_MS / 1000) + 30`. The id SHALL use an underscore, so the tools are `mcp__orchestrator_operator__<tool>`.

`hosts/codex/README.md` SHALL document the template block as the primary install. It SHALL document `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/codex>/bin/orchestrator.mjs mcp` as the alternative for a registration that keeps Codex's 60-second default tool timeout. It SHALL document verification with `codex mcp get orchestrator_operator`, and the approval keys `codex exec` needs.

`hosts/codex/skills/` SHALL hold `import`, `run`, and `review` skills, named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`, with the behaviour of "Skills" except as follows. They SHALL NOT reference `${CLAUDE_PLUGIN_ROOT}`. They SHALL have no Workflow or subagent section and SHALL name no Claude model as a default. They SHALL look for the test command in `AGENTS.md`, with `CLAUDE.md` only as the fallback when there is no `AGENTS.md`. Their toolchain line SHALL always name the runner kind. When no daemon is running and `orchestrator.yaml` sets no `runner.mode`, they SHALL call `start` with `mode: "spawn"`, so that the daemon runs the agents headless, until a Codex work loop exists; otherwise they SHALL call `start` without `mode`, because an explicit mode overrides the file and is applied to a running daemon. When the mode in force is `pull` or `mixed` they SHALL say so, and SHALL offer `spawn` unless another session holds launches of the run. They SHALL say that under `codex exec` the operator tools run only when approvals are pre-granted (`approval_policy = "never"`, `default_tools_approval_mode = "approve"`, and per-tool `approval_mode = "approve"`), and that an interactive session prompts instead. The `import` skill SHALL name the Codex form of the tracker connectors' tools (`mcp__linear__`, `mcp__atlassian__`).

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

## MODIFIED Requirements

### Requirement: Per-host wrappers
Host integrations SHALL live under `hosts/<host>/`, each containing configuration and instruction files for that host and, where the host needs them, dependency-free launcher and hook scripts. The first SHALL be `hosts/claude-code/`, a Claude Code plugin named `orchestrator` with `.claude-plugin/plugin.json`, an `.mcp.json` declaring a server `operator` that runs `node ${CLAUDE_PLUGIN_ROOT}/bin/orchestrator.mjs mcp` with a tool-call `timeout` above the `wait` cap, hooks under `hooks/`, and skills under `skills/`. The plugin directory SHALL contain a private `package.json`, named for the plugin and not for the orchestrator package, whose only dependency is the published package pinned to the exact version in `.claude-plugin/plugin.json` (no range operator), together with a committed `package-lock.json` of lockfile version 2 or 3 that resolves exactly that dependency, so that a marketplace install triggers Claude Code's automatic dependency install into `${CLAUDE_PLUGIN_ROOT}/node_modules`; it SHALL declare no other dependency, and the plugin's `node_modules` SHALL be ignored by git. The plugin SHALL pass `claude plugin validate --strict` and SHALL load with `claude --plugin-dir hosts/claude-code`. The second SHALL be `hosts/codex/`, specified under "Codex host".

#### Scenario: Plugin validates
- **WHEN** `claude plugin validate --strict hosts/claude-code` is run
- **THEN** it reports validation passed

#### Scenario: Server registers under the plugin
- **WHEN** the plugin is loaded
- **THEN** the operator server registers as `plugin:orchestrator:operator` and its tools are named `mcp__plugin_orchestrator_operator__<tool>`

#### Scenario: Server command uses the plugin root
- **WHEN** `hosts/claude-code/.mcp.json` is read
- **THEN** the `operator` server's command is `node`, its first argument is `${CLAUDE_PLUGIN_ROOT}/bin/orchestrator.mjs`, its second is `mcp`, and its `timeout` exceeds ninety seconds

#### Scenario: Plugin manifest pins the package
- **WHEN** `hosts/claude-code/package.json` and `hosts/claude-code/package-lock.json` are read
- **THEN** the manifest is private, its only dependency is the published package at exactly the plugin manifest's version, and the lockfile resolves that package at that version with lockfile version 2 or 3

### Requirement: Skills
The Claude Code plugin SHALL provide four skills. `import` SHALL require a tracker connector: a Linear or Atlassian MCP server, or GitHub through a `gh` CLI whose `gh auth status` succeeds or a GitHub MCP server; it SHALL refuse with a clear message naming the three options otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria. `run` SHALL call `start`. When the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, `run` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag. It SHALL then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report. It SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative. The `run`, `work`, and `import` skills SHALL state that codex launches are worked only in `spawn` or `mixed` mode, because pull-mode workers are the session's Claude subagents. `run` SHALL NOT start the workflow for a run whose runner kind is `codex` unless its graph has `claude-code` tasks or `claimableByKind["claude-code"]` is above zero. `review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note. `work` SHALL remain the explicit way to add workers from a session or to switch the mode. The Codex host's edition of `import`, `run`, and `review` SHALL follow these rules with the differences stated under "Codex host", and has no `work` skill. No skill SHALL instruct the user to put the package on PATH. Skills SHALL keep digests, not raw events, in the conversation.

#### Scenario: Import without a tracker
- **WHEN** the import skill is invoked in a session with no Linear or Atlassian MCP tools, no GitHub MCP tools, and `gh auth status` failing
- **THEN** it stops with a message naming the three connectors and does not call `import_issues`

#### Scenario: Import with gh only
- **WHEN** the import skill is invoked in a session with no tracker MCP tools and `gh auth status` succeeding
- **THEN** it proceeds with the GitHub path through `gh`

#### Scenario: Run loop answers a question
- **WHEN** `wait` returns an open question during the run skill
- **THEN** the skill presents it to the user and sends the user's reply through `answer` before waiting again

#### Scenario: Run skill works the run with session subagents
- **WHEN** the run skill starts a fresh run and `start` reports mode `pull`
- **THEN** the skill runs the workflow with at most `capacity` workers before its first `wait`, and every task is executed by a session subagent

#### Scenario: Run skill in spawn mode
- **WHEN** `start` reports mode `spawn`
- **THEN** the skill runs no workflow and monitors the daemon's agents as before

#### Scenario: Codex-default run is not worked by session subagents
- **WHEN** the run skill starts a run whose `config.runnerKind` is `codex` and whose graph has no `claude-code` tasks
- **THEN** `start` reports mode `spawn` with a `modeNote`, the skill tells the user that the daemon runs the Codex agents, and it runs no workflow

#### Scenario: Codex host run skill starts in spawn
- **WHEN** the `orchestrator-run` skill starts a fresh run of the default runner kind in a Codex session, in a repository whose `orchestrator.yaml` sets no `runner.mode`
- **THEN** it calls `start` with `mode: "spawn"`, runs no workflow, and monitors the daemon's agents

#### Scenario: Codex host leaves a worked pull run alone
- **WHEN** the `orchestrator-run` skill opens a run whose daemon is running in `pull` while a Claude Code session holds launches of it
- **THEN** it calls `start` without `mode`, and the mode stays `pull`
