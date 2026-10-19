## ADDED Requirements

### Requirement: OpenCode host
`hosts/opencode/` SHALL let an OpenCode session be the operator. It SHALL ship `bin/orchestrator.mjs`, the third copy of the launcher of "Plugin launcher", whose npx fallback is pinned to the version of the published package in `hosts/opencode/package.json`. `hosts/opencode/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/opencode/node_modules` SHALL be ignored by git.

`hosts/opencode/opencode.json` SHALL be the registration snippet. It SHALL declare `mcp.orchestrator_operator` with `type: "local"`, `command` set to `node`, the launcher, and `mcp`, and a per-server `timeout` in milliseconds above `WAIT_CAP_MS + 30000` (180000), because OpenCode cuts an MCP call at 60 seconds by default and the per-server `timeout` is the only cap opencode 1.18.30 honours. It SHALL have no `mcp.timeout` block, which 1.18.30 drops with a compatibility diagnostic. OpenCode names the tools `<id>_<tool>`, so they are `orchestrator_operator_<tool>`.

`hosts/opencode/README.md` SHALL document merging the snippet into `~/.config/opencode/opencode.json` or a project's `opencode.json` as the primary install, and `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/opencode>/bin/orchestrator.mjs mcp` as the alternative, which cannot set `timeout`. It SHALL document verification with `opencode mcp list`, the skills install, the plugin, the start-mode rule, and that the attachment ends when OpenCode closes the server's stdio.

`hosts/opencode/skills/` SHALL hold `import`, `run`, and `review` skills named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`. Each SHALL be the Codex host's edition with the tool prefix `mcp__orchestrator_operator__` replaced by `orchestrator_operator_`, the host name changed, and only these blocks rewritten: the operator tools' permissions in place of Codex approvals (under `opencode run` a tool whose permission is `ask` is rejected automatically, and the remedy is `"orchestrator_operator_*": "allow"`), the OpenCode form of the tracker connectors (`mcp.linear` and `mcp.atlassian` entries whose tools are `linear_<tool>` and `atlassian_<tool>`), the per-server `timeout` in place of `tool_timeout_sec`, the toolchain line and kind lists naming `opencode` (its permission and commit policy), and the pull-mode offer. A host test SHALL hold the two editions to exactly those differences. Until an OpenCode work loop exists, the skills SHALL call `start` with `mode: "spawn"` when no daemon is running and `orchestrator.yaml` sets no `runner.mode`, and without `mode` otherwise; when the mode in force is `pull` or `mixed` they SHALL say so, SHALL say that `opencode` launches are worked only under `spawn` because the loop `modeNote` names is not available yet, and SHALL offer `spawn` unless another session holds launches of the run.

`hosts/opencode/plugins/orchestrator.js` SHALL be the session plugin, installed by linking it into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`). It SHALL export exactly one function, since OpenCode calls every exported function as a plugin. It SHALL find `hooks/session-start.mjs` beside its own real path, or under `ORCH_OPENCODE_HOST` for a copied install. On `session.created` for a session without a `parentID` it SHALL run the script once with `node` and a ten-second timeout. On that session's first `chat.message` it SHALL append the script's line to the user's existing text part, SHALL never push a new part (OpenCode refuses a part without ids), and SHALL leave the message untouched when the script printed nothing. It SHALL show the line through `client.tui.showToast` and SHALL ignore a client without a TUI. It SHALL NOT use `experimental.chat.system.transform`. `hosts/opencode/hooks/` SHALL hold byte copies of the Claude Code plugin's `session-start.mjs` and `session-end.mjs`; nothing runs the end script, since OpenCode has no session end event and the operator server ends its own attachment when its stdio closes. Worker launches pass `--pure` and never load the plugin.

#### Scenario: OpenCode registration verified
- **WHEN** `OPENCODE_CONFIG` names the snippet with `<hosts/opencode>` filled in and `opencode mcp list` is run
- **THEN** it reports `orchestrator_operator` as `connected` with the launcher command

#### Scenario: operator server answers in an OpenCode session
- **WHEN** `opencode run` runs with the snippet as its config and is asked to call `orchestrator_operator_start` with `mode: "spawn"`
- **THEN** its `tool_use` event names `orchestrator_operator_start`, completed, and the result reports `mode: "spawn"`

#### Scenario: Skill editions held in step
- **WHEN** the Codex edition of a skill is changed in a block the OpenCode edition shares
- **THEN** the host test fails until the OpenCode edition carries the same change

#### Scenario: Notice appended once
- **WHEN** the plugin sees `session.created` and then two `chat.message` calls for that session while a run needs attention
- **THEN** the first message's text part ends with the start line, the second is untouched, and one toast shows the line

#### Scenario: Nothing needs attention
- **WHEN** the plugin runs with an `ORCH_HOME` that holds no run
- **THEN** the user's message part is unchanged and no toast is shown

## MODIFIED Requirements

### Requirement: Skills
The Claude Code plugin SHALL provide four skills. `import` SHALL require a tracker connector: a Linear or Atlassian MCP server, or GitHub through a `gh` CLI whose `gh auth status` succeeds or a GitHub MCP server; it SHALL refuse with a clear message naming the three options otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria. `run` SHALL call `start`. When the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, `run` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag. It SHALL then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report. It SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative. The `run`, `work`, and `import` skills SHALL state that codex launches are worked only in `spawn` or `mixed` mode, because pull-mode workers are the session's Claude subagents. `run` SHALL NOT start the workflow for a run whose runner kind is `codex` unless its graph has `claude-code` tasks or `claimableByKind["claude-code"]` is above zero. `review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note. `work` SHALL remain the explicit way to add workers from a session or to switch the mode. The Codex host's edition of `import`, `run`, and `review` SHALL follow these rules with the differences stated under "Codex host", and has no `work` skill. Codex SHALL find that edition where it discovers skills: each skill linked or copied as `~/.codex/skills/<name>` (under `CODEX_HOME`), or as `.agents/skills/<name>` in a target repository that vendors them. `hosts/codex/README.md` SHALL document both, and SHALL say that a `[[skills.config]]` entry with a `path` only selects a skill Codex has already discovered (for example to disable it) and does not load one. The OpenCode host's edition of `import`, `run`, and `review` SHALL follow the same rules with the differences stated under "OpenCode host". OpenCode SHALL find it where it discovers skills: each skill linked or copied as `~/.agents/skills/orchestrator-<name>`, or as `.opencode/skills/orchestrator-<name>` in a repository; `hosts/opencode/README.md` SHALL document both, and SHALL say not to link the Codex edition, which has the same names, into `~/.agents/skills` as well. No skill SHALL instruct the user to put the package on PATH. Skills SHALL keep digests, not raw events, in the conversation.

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

#### Scenario: OpenCode skills
- **WHEN** `hosts/opencode/skills/run` is linked as `~/.agents/skills/orchestrator-run`
- **THEN** `opencode debug skill` lists `orchestrator-run`, and the skill names the operator tools `orchestrator_operator_<tool>`

#### Scenario: Codex skills
- **WHEN** `hosts/codex/skills/run` is linked as `~/.codex/skills/orchestrator-run`, or as `.agents/skills/orchestrator-run` in the repository a Codex session works in
- **THEN** the session's skill list names `orchestrator-run`, and a `[[skills.config]]` entry whose `path` is `hosts/codex/skills/run/SKILL.md` adds nothing by itself

### Requirement: Plugin launcher
The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader; (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists; (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete. Before spawning, it SHALL compare `process.versions.node` with the package's `engines.node` floor and, when the running Node is older, SHALL print one line naming the running version and the floor to stderr and exit 1, so that a Node too old for `node:sqlite` fails with a readable message rather than `ERR_UNKNOWN_BUILTIN_MODULE`. It SHALL spawn the resolved command with inherited stdio, forward `SIGTERM`, `SIGINT`, and `SIGHUP`, exit with the child's code, and, when `ORCH_LAUNCHER_DRY_RUN` is set, print the chosen source (`checkout`, `plugin`, or `npx`) and the resolved command as JSON instead of running it. The package name constant in the launcher SHALL equal `package.json` `name`, and a host test SHALL assert it. The daemon and the agent shim SHALL keep resolving from the tree the server runs in, so that a launcher-started server spawns a daemon from the same checkout, the same plugin-local tree, or the same `npx` installation. The Codex host and the OpenCode host SHALL each ship a copy, `hosts/codex/bin/orchestrator.mjs` and `hosts/opencode/bin/orchestrator.mjs`, that differs from the plugin's only in the version source of (c): the published package's dependency pin in that host's own `package.json`, never `.claude-plugin/plugin.json`. The two host copies SHALL be identical but for comments, and a host test SHALL assert both facts.

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

#### Scenario: Third copy pinned by its host package
- **WHEN** `hosts/opencode` is copied outside any checkout without `node_modules` and its launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp`
- **THEN** it prints source `npx` with `--package=<name>@<the version in hosts/opencode/package.json>` and `orchestrator-mcp`, and its code, comments aside, is that of `hosts/codex/bin/orchestrator.mjs`

### Requirement: Session start hook
Each host SHALL run its own copy of `hooks/session-start.mjs` with `node` and a ten-second timeout when a session starts. The Claude Code plugin declares it as a `SessionStart` hook for `startup`, `resume`, and `clear` in `hooks/hooks.json`. The Codex host declares it as `[[hooks.SessionStart]]` with the same matcher in `hosts/codex/config.toml`, which SHALL also set `features.hooks = true` and say that Codex runs a hook only once it is trusted. OpenCode has no hook configuration, so the OpenCode host runs the script from its plugin on `session.created` ("OpenCode host"). The hosts' copies of the script SHALL be identical. The script SHALL read every run directory under `ORCH_HOME` (default `~/.orchestrator`), SHALL probe an alive daemon with `GET /v1/status?probe=1` and a one-second timeout, SHALL print one line naming each run whose daemon is alive (with its running, waiting, parked, attached, awaiting-review, and open-question counts) or whose daemon is dead with an exit record showing parked launches, open questions, a milestone awaiting review, or a stall (with the exit reason and age) or with no exit record (as not stopped cleanly), ending with how to continue, and SHALL print nothing when no run qualifies. It SHALL load no package code, SHALL need nothing on PATH but `node`, and SHALL exit 0 whatever happens.

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

#### Scenario: OpenCode session start
- **WHEN** an OpenCode session starts with `plugins/orchestrator.js` linked into its plugin directory while a run's daemon exited idle with two launches parked, and the user's first message asks the model to repeat any line starting with `orchestrator:`
- **THEN** the plugin runs `hosts/opencode/hooks/session-start.mjs`, the first message's text part ends with the script's line, and the model repeats that line verbatim

#### Scenario: Codex session start
- **WHEN** a Codex session starts with the template's hooks in its config, trusted, while a run's daemon exited idle with two launches parked
- **THEN** Codex runs `hosts/codex/hooks/session-start.mjs`, and its line naming the run and the parked launches is in the session's context

### Requirement: Session end hook
Each host whose CLI has a session end event SHALL declare a `SessionEnd` hook for every reason that runs its own copy of `hooks/session-end.mjs` with `node`. The Claude Code plugin declares it in `hooks/hooks.json`, and the Codex host declares it as `[[hooks.SessionEnd]]` in `hosts/codex/config.toml`. OpenCode 1.18.30 has no session end event (`session.idle` fires after every turn), so the OpenCode host declares none and ships the script only as a copy. The hosts' copies of the script SHALL be identical. The script SHALL read the hook input for `reason`, and SHALL use `sessionEnded` when the input has none or is not JSON. It SHALL collect its own ancestor process ids up to six levels within 300 ms, SHALL post `{ pids, reason }` to `POST /v1/attachments/ended` of every alive daemon under `ORCH_HOME` in parallel with 400 ms timeouts, SHALL NOT wait for any release, and SHALL exit 0 within the SessionEnd budget whatever happens. It SHALL load no package code. The hook is not needed to release a session's launches. The operator server ends its own attachment when its stdio closes, and the daemon ends attachments whose first pid is dead (operator-control "Session attachments"). What the hook adds is the host's reason.

#### Scenario: Session end releases its workers' launches
- **WHEN** a session whose MCP server holds an attachment with a claimed launch ends with reason `prompt_input_exit`
- **THEN** the daemon records the attachment as ended and the next reconcile releases the launch with `keep`

#### Scenario: Hook under the budget
- **WHEN** the hook runs with three alive daemons under `ORCH_HOME`
- **THEN** it exits 0 in under one second

#### Scenario: No daemon alive
- **WHEN** the hook runs with stdin `{ "reason": "x" }` and no run under `ORCH_HOME` has an alive daemon
- **THEN** it posts nothing and exits 0 within one second

#### Scenario: OpenCode session end
- **WHEN** an OpenCode session ends whose operator server holds an attachment with a claimed launch
- **THEN** no hook runs; OpenCode closes the server's stdio, the server ends its own attachment with reason `sessionEnded`, and the next reconcile releases the launch with `keep`

#### Scenario: Codex session end
- **WHEN** a Codex session ends whose operator server holds an attachment with a claimed launch, with the template's hooks in its config and trusted
- **THEN** Codex runs `hosts/codex/hooks/session-end.mjs` as a child of the codex process, which is also the operator server's ancestor, with input `reason` `"other"`; the daemon records the attachment as ended with reason `other`, and the next reconcile releases the launch with `keep`
