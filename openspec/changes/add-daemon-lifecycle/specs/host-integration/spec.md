## ADDED Requirements

### Requirement: Plugin launcher
The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader; (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists; (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete. Before spawning, it SHALL compare `process.versions.node` with the package's `engines.node` floor and, when the running Node is older, SHALL print one line naming the running version and the floor to stderr and exit 1, so that a Node too old for `node:sqlite` fails with a readable message rather than `ERR_UNKNOWN_BUILTIN_MODULE`. It SHALL spawn the resolved command with inherited stdio, forward `SIGTERM`, `SIGINT`, and `SIGHUP`, exit with the child's code, and, when `ORCH_LAUNCHER_DRY_RUN` is set, print the chosen source (`checkout`, `plugin`, or `npx`) and the resolved command as JSON instead of running it. The package name constant in the launcher SHALL equal `package.json` `name`, and a host test SHALL assert it. The daemon and the agent shim SHALL keep resolving from the tree the server runs in, so that a launcher-started server spawns a daemon from the same checkout, the same plugin-local tree, or the same `npx` installation.

#### Scenario: Node below the floor
- **WHEN** the launcher runs under a Node older than the package's `engines.node` floor
- **THEN** it prints one line naming the running version and the floor to stderr, exits 1, and spawns nothing

#### Scenario: Checkout resolves in place
- **WHEN** the launcher runs from `hosts/claude-code/bin/` inside a built checkout with `mcp --help`
- **THEN** it runs `dist/src/operator/mcp.js`, prints the operator MCP server usage, and the dry run names source `checkout`

#### Scenario: Plugin-local copy resolves
- **WHEN** the plugin directory is copied outside any checkout with `node_modules/<name>/dist/src/operator/mcp.js` present and the launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp`
- **THEN** it prints source `plugin` with `node` and that file as the command

#### Scenario: Missing plugin-local tree falls back to npx
- **WHEN** the plugin directory is copied outside any checkout without `node_modules`, or with a `node_modules/<name>` that lacks `dist`, and the launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp`
- **THEN** it prints source `npx` with `--package=<name>@<plugin manifest version>` and `orchestrator-mcp`

#### Scenario: Unbuilt checkout falls back to tsx
- **WHEN** the checkout has no `dist` but has `node_modules/tsx`
- **THEN** the launcher runs the TypeScript entry through the loader

### Requirement: Session start hook
The plugin SHALL declare a `SessionStart` hook for `startup`, `resume`, and `clear` in `hooks/hooks.json` running `hooks/session-start.mjs` with a ten-second timeout. The script SHALL read every run directory under `ORCH_HOME` (default `~/.orchestrator`), SHALL probe an alive daemon with `GET /v1/status?probe=1` and a one-second timeout, SHALL print one line naming each run whose daemon is alive (with its running, waiting, parked, attached, awaiting-review, and open-question counts) or whose daemon is dead with an exit record showing parked launches, open questions, a milestone awaiting review, or a stall (with the exit reason and age) or with no exit record (as not stopped cleanly), ending with how to continue, and SHALL print nothing when no run qualifies. It SHALL load no package code, SHALL need nothing on PATH but `node`, and SHALL exit 0 whatever happens.

#### Scenario: Alive daemon reported
- **WHEN** a session starts while a daemon for `/Users/r/app` is alive with T2 running and MVP awaiting review
- **THEN** the hook's stdout is one line naming `/Users/r/app`, the alive daemon, T2 running, and MVP awaiting review

#### Scenario: Idle-exited run with parked work reported
- **WHEN** a run's daemon exited idle with two launches parked
- **THEN** the line names the run, `idle`, the age of the exit, and the two parked launches

#### Scenario: Finished run stays silent
- **WHEN** every run under `ORCH_HOME` finished and its daemon exited idle
- **THEN** the hook prints nothing

#### Scenario: Not stopped cleanly
- **WHEN** a run's `daemon.pid` is dead and its `daemon.json` has no exit record
- **THEN** the line names the run as not stopped cleanly

### Requirement: Session end hook
The plugin SHALL declare a `SessionEnd` hook for every reason in `hooks/hooks.json` running `hooks/session-end.mjs`. The script SHALL read the hook input for `reason`, SHALL collect its own ancestor process ids up to six levels within 300 ms, SHALL post `{ pids, reason }` to `POST /v1/attachments/ended` of every alive daemon under `ORCH_HOME` in parallel with 400 ms timeouts, SHALL NOT wait for any release, and SHALL exit 0 within the SessionEnd budget whatever happens. It SHALL load no package code.

#### Scenario: Session end releases its workers' launches
- **WHEN** a session whose MCP server holds an attachment with a claimed launch ends with reason `prompt_input_exit`
- **THEN** the daemon records the attachment as ended and the next reconcile releases the launch with `keep`

#### Scenario: Hook under the budget
- **WHEN** the hook runs with three alive daemons under `ORCH_HOME`
- **THEN** it exits 0 in under one second

#### Scenario: No daemon alive
- **WHEN** the hook runs and no run under `ORCH_HOME` has an alive daemon
- **THEN** it posts nothing and exits 0

## MODIFIED Requirements

### Requirement: Package entrypoints
The npm package SHALL declare subpath exports `.` for the core library, `./daemon`, `./operator-mcp`, and `./agent-shim`, and SHALL install the executables `orchestrator`, `orchestrator-ctl`, `orchestrator-mcp`, and `orchestrator-mcp-shim`. The package SHALL be publishable as `@autodidacticon/orchestrator`: not `private`, with `publishConfig.access` `public`, `prepublishOnly` running the build, and `files` covering `dist/src`, `hosts`, and `README.md`. Host wrappers SHALL NOT reference executables by name on PATH; they SHALL reach the package through the plugin launcher, which resolves a checkout or the published package.

#### Scenario: Executables on PATH
- **WHEN** the package is installed globally or linked
- **THEN** all four executables are runnable by name and `orchestrator-mcp --help` prints usage

#### Scenario: Nothing on PATH
- **WHEN** the plugin is loaded with `--plugin-dir` from a built checkout in a shell where no package executable is on PATH
- **THEN** the operator server starts and its tools answer

### Requirement: Per-host wrappers
Host integrations SHALL live under `hosts/<host>/`, each containing configuration and instruction files for that host and, where the host needs them, dependency-free launcher and hook scripts. The first SHALL be `hosts/claude-code/`, a Claude Code plugin named `orchestrator` with `.claude-plugin/plugin.json`, an `.mcp.json` declaring a server `operator` that runs `node ${CLAUDE_PLUGIN_ROOT}/bin/orchestrator.mjs mcp` with a tool-call `timeout` above the `wait` cap, hooks under `hooks/`, and skills under `skills/`. The plugin directory SHALL contain a private `package.json`, named for the plugin and not for the orchestrator package, whose only dependency is the published package pinned to the exact version in `.claude-plugin/plugin.json` (no range operator), together with a committed `package-lock.json` of lockfile version 2 or 3 that resolves exactly that dependency, so that a marketplace install triggers Claude Code's automatic dependency install into `${CLAUDE_PLUGIN_ROOT}/node_modules`; it SHALL declare no other dependency, and the plugin's `node_modules` SHALL be ignored by git. The plugin SHALL pass `claude plugin validate --strict` and SHALL load with `claude --plugin-dir hosts/claude-code`.

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
The plugin SHALL provide four skills. `import` SHALL require a tracker MCP server (Linear or Atlassian) to be connected, SHALL refuse with a clear message otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria. `run` SHALL call `start`, and when the mode in force is `pull` or `mixed` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag, then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report; it SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative. `review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note. `work` SHALL remain the explicit way to add workers from a session or to switch the mode. No skill SHALL instruct the user to put the package on PATH. Skills SHALL keep digests, not raw events, in the conversation.

#### Scenario: Import without a tracker
- **WHEN** the import skill is invoked in a session with no Linear or Atlassian MCP tools
- **THEN** it stops with a message naming the missing connector and does not call `import_issues`

#### Scenario: Run loop answers a question
- **WHEN** `wait` returns an open question during the run skill
- **THEN** the skill presents it to the user and sends the user's reply through `answer` before waiting again

#### Scenario: Run skill works the run with session subagents
- **WHEN** the run skill starts a fresh run and `start` reports mode `pull`
- **THEN** the skill runs the workflow with at most `capacity` workers before its first `wait`, and every task is executed by a session subagent

#### Scenario: Run skill in spawn mode
- **WHEN** `start` reports mode `spawn`
- **THEN** the skill runs no workflow and monitors the daemon's agents as before

### Requirement: Marketplace manifest
The repository SHALL contain `.claude-plugin/marketplace.json` at its root listing the `orchestrator` plugin with `source: "./hosts/claude-code"`, so that `claude plugin marketplace add <owner>/orchestrator` installs the plugin. Because a marketplace install copies only the plugin directory, the installed plugin SHALL be self-contained: the plugin-local install from its `package.json` and lockfile SHALL provide the package, and the launcher SHALL fall back to the published package at the plugin manifest's version through `npx` when that tree is missing or incomplete. The plugin manifest version, the package version, and the pin in the plugin's `package.json` SHALL be equal, the launcher's package name and the pinned dependency SHALL equal the package name `@autodidacticon/orchestrator`, the lockfile SHALL be present and consistent with the pin, and a test SHALL assert all of it. The plugin SHALL still pass `claude plugin validate --strict` with the work skill, the workflow, the launcher, the plugin manifest, and the hooks present.

#### Scenario: Versions match
- **WHEN** the host tests run
- **THEN** `hosts/claude-code/.claude-plugin/plugin.json`, `package.json`, and the pin in `hosts/claude-code/package.json` report the same version, the launcher and the pin name the package, the lockfile resolves it at that version, and the marketplace manifest names the plugin with that source

#### Scenario: Plugin validates with the additions
- **WHEN** `claude plugin validate --strict hosts/claude-code` is run after the launcher and hooks are added
- **THEN** it reports validation passed

#### Scenario: Installed copy is self-contained
- **WHEN** the plugin directory alone is copied to another location, its dependencies are installed from its lockfile with scripts disabled, and the launcher is asked for `mcp` in dry-run mode
- **THEN** it resolves to the plugin-local copy of the package at the manifest's version and references nothing outside the copy

#### Scenario: Installed copy without the install still works
- **WHEN** the plugin directory alone is copied to another location without installing its dependencies and the launcher is asked for `mcp` in dry-run mode
- **THEN** it resolves to `npx` with the published package at the manifest's version and references nothing outside the copy
