## ADDED Requirements

### Requirement: Package entrypoints
The npm package SHALL declare subpath exports `.` for the core library, `./daemon`, `./operator-mcp`, and `./agent-shim`, and SHALL install the executables `orchestrator`, `orchestrator-ctl`, `orchestrator-mcp`, and `orchestrator-mcp-shim`. Host wrappers SHALL reference executables by name, never by a path inside the package.

#### Scenario: Executables on PATH
- **WHEN** the package is installed globally or linked
- **THEN** all four executables are runnable by name and `orchestrator-mcp --help` prints usage

### Requirement: Per-host wrappers
Host integrations SHALL live under `hosts/<host>/`, each containing only configuration and instruction files for that host. The first SHALL be `hosts/claude-code/`, a Claude Code plugin named `orchestrator` with `.claude-plugin/plugin.json`, an `.mcp.json` declaring a server `operator` that runs `orchestrator-mcp` with a tool-call `timeout` above the `wait` cap, and skills under `skills/`. The plugin SHALL pass `claude plugin validate --strict` and SHALL load with `claude --plugin-dir hosts/claude-code`.

#### Scenario: Plugin validates
- **WHEN** `claude plugin validate --strict hosts/claude-code` is run
- **THEN** it reports validation passed

#### Scenario: Server registers under the plugin
- **WHEN** the plugin is loaded
- **THEN** the operator server registers as `plugin:orchestrator:operator` and its tools are named `mcp__plugin_orchestrator_operator__<tool>`

### Requirement: Skills
The plugin SHALL provide three skills. `import` SHALL require a tracker MCP server (Linear or Atlassian) to be connected, SHALL refuse with a clear message otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria. `run` SHALL call `start`, then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, and stopping on finished or stalled with a report. `review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note. Skills SHALL keep digests, not raw events, in the conversation.

#### Scenario: Import without a tracker
- **WHEN** the import skill is invoked in a session with no Linear or Atlassian MCP tools
- **THEN** it stops with a message naming the missing connector and does not call `import_issues`

#### Scenario: Run loop answers a question
- **WHEN** `wait` returns an open question during the run skill
- **THEN** the skill presents it to the user and sends the user's reply through `answer` before waiting again
