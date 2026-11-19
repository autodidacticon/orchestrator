# Host Integration Specification

## Purpose
How the orchestrator is packaged for host sessions: the npm package's subpath exports and executables, thin per-host wrappers under `hosts/<host>/` such as the Claude Code plugin, the import, run, and review skills those wrappers ship, including how the import skill records the tracker and how the run skill mirrors the run back to it by draining the outbox, handles stuck tasks and budget pauses on the user's say, presents pending proposals for the user to accept or reject, creating the tracker issue first in a tracker-backed run, and offers `cascade` with its plan when a reopen is refused for its blockers, the `work` skill and the bundled `workflows/work.js` workflow through which a session fans out worker subagents that claim and work prepared launches in `pull` or `mixed` mode, and the marketplace manifest at the repository root through which the plugin is installed.

## Requirements

### Requirement: Package entrypoints
The npm package SHALL declare subpath exports `.` for the core library, `./daemon`, `./operator-mcp`, and `./agent-shim`, and SHALL install the executables `orchestrator`, `orchestrator-ctl`, `orchestrator-mcp`, and `orchestrator-mcp-shim`.

#### Scenario: Executables on PATH
- **WHEN** the package is installed globally or linked
- **THEN** all four executables are runnable by name and `orchestrator-mcp --help` prints usage

#### Scenario: Nothing on PATH
- **WHEN** the plugin is loaded with `--plugin-dir` from a built checkout in a shell where no package executable is on PATH
- **THEN** the operator server starts and its tools answer

### Requirement: Per-host wrappers
Host integrations SHALL live under `hosts/<host>/`, each containing configuration and instruction files for that host and, where the host needs them, dependency-free launcher and hook scripts. The second host SHALL be `hosts/codex/`, specified under "Codex host".

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
The Claude Code plugin SHALL provide four skills.

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

### Requirement: Import skill records the tracker
The `import` skill SHALL pass `tracker` to `import_issues`, with `kind` `linear`, `atlassian`, or `github` according to the connector it fetched from and `workspace` naming the Linear workspace, the Jira site, or the GitHub repository as `owner/repo`.

#### Scenario: Linear import names its tracker
- **WHEN** the import skill fetches an epic through the Linear tools
- **THEN** its `import_issues` call carries `tracker.kind` `linear`

#### Scenario: GitHub epic with a cross-repository blocker
- **WHEN** issue `acme/app#40` has sub-issues `#41` (open, labelled `in-progress`) and `#42` (closed, `COMPLETED`), `#41` is blocked by `acme/infra#7` (open), and the tracker is `{ kind: github, workspace: "acme/app", inProgressLabel: "in-progress" }`
- **THEN** the records are root `GH-40`, `GH-41` with state `inProgress` and `blockedBy: ["GH-acme-infra-7"]`, `GH-42` with state `done`, and `GH-acme-infra-7` with state `open`, each carrying its URL, and the mapped graph has `GH-41` as a task, `GH-42` and `GH-acme-infra-7` as external nodes

#### Scenario: Milestone root
- **WHEN** the user names the milestone "M1" of `acme/app`
- **THEN** the root record is `GH-M<number>` with the milestone's URL and state, and the milestone's issues are its children

#### Scenario: Priority from a label
- **WHEN** a child carries the labels `P1` and `backend`
- **THEN** its record has `priority: 1` and `labels: ["P1", "backend"]`

### Requirement: Run skill mirrors to the tracker
After every `wait` return, before acting on the digest, the `run` skill SHALL drain the outbox: call `outbox`; apply each effect in `id` order with the session's tracker tools; and for each effect either `ack` with the vendor result or `ack` with the error. After an error on one issue it SHALL leave that issue's later effects for the next drain.

#### Scenario: Drain after wait
- **WHEN** `wait` returns and `outbox` lists a `setState inProgress` for ENG-12 and a `comment` for ENG-13
- **THEN** the skill sets ENG-12 to the started-type state, posts the comment with its marker on ENG-13, and acknowledges both with the vendor ids before calling `wait` again

#### Scenario: GitHub states
- **WHEN** the outbox lists `setState done` for `GH-41`, `setState cancelled` for `GH-43`, and `setState inProgress` for `GH-42`, which is closed, under a policy with `inProgressLabel: "in-progress"`
- **THEN** `#41` is closed as completed and `#43` as not planned, each with the `in-progress` label removed if it was present, `#42` is reopened and labelled `in-progress`, and all three effects are acknowledged

#### Scenario: No in-progress label configured
- **WHEN** the outbox lists `setState inProgress` for `GH-41` and the policy has no `inProgressLabel`
- **THEN** the skill acknowledges the effect with a result saying it was skipped and changes nothing on GitHub

#### Scenario: Comment survives a session crash
- **WHEN** the previous session posted a comment but crashed before acknowledging it
- **THEN** the next drain finds the marker on the issue and acknowledges with the existing comment's id without posting again

#### Scenario: No canceled-type state
- **WHEN** a `setState cancelled` targets a Jira project whose workflow has no canceled-type status
- **THEN** the skill leaves the status, posts a comment saying the task was cancelled, and acknowledges the effect

#### Scenario: Answer from a comment
- **WHEN** ENG-12 has an open question and a teammate replies under the question comment
- **THEN** the skill sends the reply through `answer` for ENG-12 and does not relay it again on later drains

#### Scenario: Terminal answer wins
- **WHEN** the user answered ENG-12 in the session and a comment answer is relayed afterwards
- **THEN** the daemon answers 409 with a reason naming ENG-12's current status and the skill reports it without retrying

#### Scenario: Proposal becomes a sub-issue
- **WHEN** the user accepts a proposal from `GH-41` in a run rooted at `GH-40`
- **THEN** the skill creates an issue as a sub-issue of `#40` blocked by `#41` and calls `accept_proposal` with `nodeId` `GH-<its number>`

### Requirement: Run skill handles health events
The `run` skill SHALL act on two more digest conditions. When `stuck` is non-empty it SHALL show each task with its idle time and last signal from `status` and offer the user a nudge with a message, cancellation, or continuing to wait, acting through `nudge` or `cancel`. When `pausedReason` is `costBudget` it SHALL report the run cost and the ceiling from `status` and offer `resume` with `overrideBudget` or stopping; it SHALL NOT override the budget without the user's say.

#### Scenario: Stuck task surfaced
- **WHEN** `wait` returns a digest with T3 under `stuck`
- **THEN** the skill shows T3 with its idle time and offers nudge, cancel, or wait, and sends the user's message through `nudge` if chosen

#### Scenario: Budget pause surfaced
- **WHEN** `wait` returns a digest with `pausedReason` `costBudget`
- **THEN** the skill reports the run cost and the ceiling and calls `resume` with `overrideBudget` only after the user agrees

### Requirement: Run skill handles proposals
When the digest's `proposals` is non-empty the run skill SHALL present each pending proposal to the user with its title, description, acceptance criteria, and deps, and SHALL wait for a decision. The skill SHALL never accept a proposal without the user.

#### Scenario: Tracker-backed acceptance
- **WHEN** the run was imported from Linear and the user accepts `T2-p1`
- **THEN** the skill creates a Linear issue under the epic blocked by T2's issue with the criteria in its description and calls `accept_proposal` with that issue's key as `nodeId`

#### Scenario: File-based acceptance
- **WHEN** the run came from a graph file and the user accepts `T2-p1`
- **THEN** the skill calls `accept_proposal` with no `nodeId` and reports the new node `T2-p1`

#### Scenario: Reopen refused then cascade offered
- **WHEN** the user asks to reopen T1 and `reopen` returns `blockers` [T2]
- **THEN** the skill tells the user T2 would be reset, and calls `reopen` with `cascade` only after the user agrees

### Requirement: Work skill and workflow
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. Workflow results SHALL be short outcomes, never briefs or logs.

#### Scenario: Two workers drain a graph
- **WHEN** the work skill runs with two workers on a three-task graph in `pull` mode
- **THEN** every task is claimed, worked, and submitted by a worker, the integration branch gains one trailer commit per task, and the workflow returns when the run is finished

#### Scenario: Question ends the loop and a re-run resumes it
- **WHEN** a worker asks a question nobody answers and nothing else is claimable
- **THEN** the workflow returns with the question in the digest, the skill answers it through the user, and the re-run worker with the same id receives the answer through `launch_block`

#### Scenario: Worker agent runs with the claimed selection
- **WHEN** a loop claims a launch whose response carries `model: "claude-sonnet-5-5"` and `effort: "low"`
- **THEN** the worker agent for that launch is started with model `claude-sonnet-5-5` and effort `low`

#### Scenario: Claimer runs cheap by default
- **WHEN** the workflow runs without `claimModel` or `claimEffort`
- **THEN** every claimer agent is started with model `claude-haiku-5-5` and effort `low`, and a run with `claimModel: "claude-sonnet-5-5"` starts them with that model instead

#### Scenario: Idle loop polls inside one claimer
- **WHEN** nothing is claimable and the stop rule does not hold
- **THEN** one claimer agent waits, reads status, and claims again up to three times before returning, and a launch parked during a wait is claimed on the next poll of the same agent

#### Scenario: Labels share the worker id
- **WHEN** worker `work-1-2` claims KNO-10
- **THEN** the view shows an agent labelled `claim work-1-2` followed by one labelled `work work-1-2 KNO-10`

#### Scenario: Worktrees outside the repository need an allowed directory
- **WHEN** a headless session in `acceptEdits` mode runs the workflow with `--add-dir` naming `ORCH_HOME`
- **THEN** its workers edit and commit in the worktrees without a permission prompt, and without that flag the first edit is refused

#### Scenario: Workers clamped to capacity
- **WHEN** the workflow is run with `workers: 6` and `capacity: 2`
- **THEN** two loops run and the log says the count was clamped

#### Scenario: Codex launches are not claimed by the Claude worker loop
- **WHEN** a mixed-mode run holds a parked `codex` launch and a parked `claude-code` launch and the workflow runs
- **THEN** a worker claims the `claude-code` launch only, the `codex` launch stays parked until the claim window passes and the daemon spawns it, and the loop's stop rule counts only `claimableByKind["claude-code"]`

#### Scenario: A launch being prepared keeps the claimer polling
- **WHEN** nothing is claimable for `claude-code`, a question is open, and `status.preparingByKind["claude-code"]` is 1 because a launch's prepare command runs
- **THEN** the claimer's stop is false and it polls again; a status without `preparingByKind` is read as 0

#### Scenario: Workflow started inline from the plugin
- **WHEN** a session that has not added the plugin directory runs the work or run skill in `pull` mode
- **THEN** the skill reads `<plugin dir>/workflows/work.js` and calls the Workflow tool with its text as `script` and the same `args`, and the workflow starts without a `scriptPath` refusal

### Requirement: Marketplace manifest
The repository SHALL contain `.claude-plugin/marketplace.json` at its root listing the `orchestrator` plugin with `source: "./hosts/claude-code"`, so that `claude plugin marketplace add <owner>/orchestrator` installs the plugin.

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

### Requirement: No native dependencies
The npm package SHALL depend only on pure-JavaScript packages: no production dependency, direct or transitive, optional dependencies included, SHALL carry an `install`, `preinstall`, or `postinstall` script or a `binding.gyp`, so that an install with `--ignore-scripts`, such as a Claude Code plugin's automatic dependency install, yields a working package. A host test SHALL assert the property from `package-lock.json` and the installed tree.

#### Scenario: Lockfile has no native module
- **WHEN** the host tests read `package-lock.json` and `node_modules`
- **THEN** no entry other than a dev-only one carries `hasInstallScript`, no production package directory contains `binding.gyp`, and `better-sqlite3` is in neither `dependencies` nor `devDependencies`

#### Scenario: Node floor declared
- **WHEN** the host tests read `package.json`
- **THEN** `engines.node` is `>=22.13.0`

#### Scenario: Postgres driver is pure JavaScript
- **WHEN** the state tests read `package-lock.json`
- **THEN** `node_modules/pg` is a production entry, no production entry carries `hasInstallScript`, and no `pg-native` or `libpq` entry exists

### Requirement: Quiet SQLite binding
No executable of the package SHALL write the `node:sqlite` ExperimentalWarning to stderr, and the daemon log SHALL NOT contain it, whether the process was started by `daemonCommand()`, by a host, by `npx`, or directly from a terminal. Every other process warning SHALL still be printed. After the warning has been handled, or after the first turn of the event loop if it never arrives, the process's `warning` listeners SHALL be the ones that were installed before the store was loaded.

#### Scenario: Direct invocation is clean
- **WHEN** `orchestrator-ctl --data-dir <empty directory> status` runs
- **THEN** it exits with status 2 and stderr carries only the `no daemon url recorded` error

#### Scenario: Daemon log is clean
- **WHEN** a daemon started by `startDaemon` has run and stopped
- **THEN** its `daemon.log` contains no `ExperimentalWarning` line

#### Scenario: Other warnings still print
- **WHEN** a process that has opened the store calls `process.emitWarning` with another warning
- **THEN** that warning is written to stderr

#### Scenario: Listeners restored
- **WHEN** the store module has been loaded and one turn of the event loop has passed
- **THEN** `process.listeners('warning')` is the list that was installed before the load, in the same order

### Requirement: Plugin launcher
The plugin SHALL ship `bin/orchestrator.mjs`, a dependency-free ES module that locates the plugin directory from its own module URL, takes `mcp`, `ctl`, `daemon`, or `shim` as its first argument, and runs the corresponding package executable from the first of three sources that applies, (a), (b), and (c), each stated in a requirement of its own ("Plugin launcher: checkout source", "Plugin launcher: plugin-local source", "Plugin launcher: npx source").

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
Each host SHALL run its own copy of `hooks/session-start.mjs` with `node` and a ten-second timeout when a session starts. The Claude Code plugin declares it as a `SessionStart` hook for `startup`, `resume`, and `clear` in `hooks/hooks.json`.

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
Each host whose CLI has a session end event SHALL declare a `SessionEnd` hook for every reason that runs its own copy of `hooks/session-end.mjs` with `node`. The Claude Code plugin declares it in `hooks/hooks.json`, and the Codex host declares it as `[[hooks.SessionEnd]]` in `hosts/codex/config.toml`. OpenCode 1.18.30 has no session end event (`session.idle` fires after every turn), so the OpenCode host declares none and ships the script only as a copy.

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

### Requirement: Skills report the toolchain
After `start` returns, the `run`, `import`, and `work` skills SHALL report the resolved toolchain to the user in one line. The line SHALL name the check command, the integration branch, the worker kind with its model and effort (`config.runnerKind`, `config.model`, `config.effort`), and the source of each.

#### Scenario: Detected toolchain reported
- **WHEN** the run skill calls `start` in a Node repository and the result shows `checkCommand` detected as `npm test` on `main` with the default runner kind, model, and effort
- **THEN** the skill tells the user "detected: npm test on main; workers claude-opus-5-5 at medium" with the sources before looping on `wait`

#### Scenario: Codex toolchain reported
- **WHEN** the run skill calls `start` in a Node repository whose `orchestrator.yaml` sets `runner.kind: codex`, and the result shows `checkCommand` detected as `npm test` on `main` with the Codex default model and effort
- **THEN** the skill tells the user "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits", with no allow-list part

#### Scenario: Unresolved command found in CLAUDE.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and `CLAUDE.md` says "run tests with `make check`"
- **THEN** the skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `CLAUDE.md`

#### Scenario: Unresolved command with nothing documented
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and neither `CLAUDE.md`, the README, nor a manifest names a test command
- **THEN** the skill asks the user for the command and calls `configure` only with what the user gives

#### Scenario: Access question answered without a restart
- **WHEN** `wait` returns a `needsAccess` question from T2 asking to run `docker compose up`
- **THEN** the skill offers to add `Bash(docker:*)` for later launches, says T2's live agent cannot gain it, and offers to run the command and answer T2 with the result

#### Scenario: OpenCode access question
- **WHEN** `wait` returns a `needsAccess` question from T3, an `opencode` launch whose command was rejected under `permission: derived`
- **THEN** the skill offers `configure` with `permission: "allow"` for later opencode launches, says T3's live agent cannot gain it, and offers to run the command and answer T3 with the result

#### Scenario: OpenCode toolchain reported
- **WHEN** the run or import skill calls `start` on a run whose `config.runnerKind` is `opencode` with the defaults
- **THEN** the skill tells the user "detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits", with no allow-list part

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

### Requirement: Work loop by runner kind
The Codex host SHALL ship `hosts/codex/bin/work.mjs`, also the package executable `orchestrator-work`; it is the work loop of the Codex and OpenCode hosts. It SHALL depend only on node built-ins and the orchestrator package, which it finds as the launcher does: a checkout, else the host-local install, else npx at the version pinned in `hosts/codex/package.json`. Starting it from a shell SHALL be the documented primary path, because a background process outliving an agent turn is unverified.
- It SHALL take `--runner <codex|opencode>`, with `codex` as the default so that an invocation without the flag behaves as before, and SHALL refuse any other kind. `--help` SHALL name the flag and its default. It SHALL take `--workers`, `--run-tag` and `--capacity`, and SHALL clamp the worker count to the capacity when one is given, logging the clamp. It SHALL take `--max-silence-ms` (see "Work loop ends a hung agent"), and `--help` SHALL name it. It SHALL find the daemon by `--url`, `ORCH_URL`, or the run directory of `--repo` (default: the current directory).
- It SHALL find the kind's runner module (`src/runner/<kind>.ts` under tsx in a checkout, else `dist/src/runner/<kind>.js`) and SHALL keep everything that differs by kind in one adapter per kind: the claim's settings block, `prepare` (the shim's inputs and the environment additions), `compose` (the shell command), whether a turn began, `parseUsage` and `classifyFailure`. Both adapters SHALL use the functions the runner modules export, so that a claimed launch and a spawned one are composed by the same code.
- It SHALL run one loop per worker in one process, starting the n-th loop's first claim (n-1)·300 ms late. Each loop SHALL claim over `POST /v1/claims` with `workerId <runTag>-<n>`, `access: "local"` and `runner` set to the chosen kind.
- For a codex claim the loop SHALL write the shim env file from the claim's `codex.env` and run `codex exec` in the claimed worktree, composed by `composeCodexCommand(launch, policy)` from the claim's `codex.settings`, `codex.maxWaitMs`, `model` and `effort`.
- For an opencode claim the loop SHALL build the per-launch config with `openCodeConfig(opencode.settings, opencode.allowedTools, opencode.maxWaitMs)`, write it through `prepareOpenCodeLaunch` (`.orchestrator/opencode.json`, 0600), and run `opencode run` in the claimed worktree, composed by `composeOpenCodeCommand(launch, policy)` from `opencode.settings`, `model` and `effort`. The environment SHALL carry the claim's `opencode.env` (from which the shim, an MCP child that inherits it, takes `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS` and `ORCH_COMMIT_POLICY`) and the additions `prepareOpenCodeLaunch` returns: `OPENCODE_CONFIG_CONTENT`, and `XDG_DATA_HOME` or `XDG_CONFIG_HOME` when the settings ask for them. No env file is written.
- Either way the loop process's own `ORCH_*` variables SHALL be dropped from the child environment. Stdin SHALL be a short preamble followed by the brief, redirected from `.orchestrator/<kind>-work-prompt.md`. The preamble SHALL name the launch, say that the orchestrator MCP server's tools carry its credentials (for opencode by their names `orchestrator_heartbeat`, `orchestrator_report`, `orchestrator_block`, `orchestrator_inbox`, `orchestrator_log`), say to stop on a 401, and say to retry rather than write a fallback report file. It SHALL carry the claim's `pending` question or answer when there is one.
- After the agent exits, the loop SHALL post the usage (codex: summed over `turn.completed` lines; opencode: summed over `step_finish` events by `parseOpenCodeUsage`) to `POST /v1/launches/:id/usage` with its worker id. When the loop did not end the agent itself and the launch is still held and running or waiting, the loop SHALL release it: with `keep: true` when the agent failed to start (codex: no turn began; opencode: no event, that is `exitBeforeTurn` or `startupContended`), and without keep when it ran but did not report. The release reason SHALL name the failure `classifyCodexFailure` or `classifyOpenCodeFailure` gave. After a `startupContended` release the loop SHALL wait between 0.5 and 1.5 s before it claims again.
- A loop SHALL stop when the run is finished or stalled; or when nothing is claimable for its kind (`claimableByKind.<kind>` is 0), nothing is being prepared for it (`preparingByKind.<kind>` is 0; a status without the field counts as 0), no launch of that kind is live, no task is awaiting the verifier (`status.verifying` is empty), and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`. A review is a node in `awaitingReview` that is not in `verifying`; a submitted task awaiting its check waits on no human, and its result can make a dependent claimable or send the task back for another launch. The log line SHALL name the kind. It SHALL also stop after `--max-failures` launches in a row that ended without the agent running or reporting; a contended start counts, and so does an agent the loop ended as hung.
- While nothing is claimable a loop SHALL long-poll `GET /v1/events` instead of spinning. The poll SHALL be filtered to the `launch.claimable`, `launch.ended` and `launch.released` kinds, so that other loops' claim events do not wake it.
- On SIGINT or SIGTERM the process SHALL end its agents' process groups (SIGTERM, then SIGKILL after a grace period) and release their launches with `keep: true`.
- The Codex host's run skill SHALL document the loop as the way to work a `pull` or `mixed` codex run, and the OpenCode host's run skill and README SHALL document `--runner opencode` as the way to work a `pull` or `mixed` opencode run.

#### Scenario: Two workers drain a graph
- **WHEN** `orchestrator-work --workers 2 --run-tag cx` runs against a three-task `pull` run with `runner.kind: codex`
- **THEN** every launch is claimed by `cx-1` or `cx-2` with `runner: "codex"` and has no pid, every task is done with one trailer commit per task on the integration branch, every launch row carries tokens with `usageSource: "worker"`, and both loops exit once the run is finished

#### Scenario: A verifying task keeps the loops running
- **WHEN** both loops find nothing claimable and nothing live while T1 is submitted and awaiting its check, and T2, which depends on T1, is not yet admitted
- **THEN** neither loop stops; T2 is claimed once T1 is done, and the loops stop with "the run is finished"

#### Scenario: Codex fails to start
- **WHEN** the loop claims a launch and the `codex` executable exits before any turn starts
- **THEN** the launch is released with `keep: true`, the task returns to `unstarted` at no cost when nothing was touched, and after `--max-failures` such launches the loop stops

#### Scenario: Same command as a spawned launch
- **WHEN** a codex launch is claimed instead of spawned
- **THEN** the `codex exec` command differs from the Codex runner's only in the file fed to stdin

#### Scenario: Workers clamped to capacity
- **WHEN** the loop is started with `--workers 4 --capacity 2`
- **THEN** two loops run and the log says the count was clamped

#### Scenario: OpenCode launch claimed
- **WHEN** `orchestrator-work --runner opencode` claims a launch of a `pull` run with `runner.kind: opencode`
- **THEN** it runs `opencode run ... < .orchestrator/opencode-work-prompt.md` in the worktree with `OPENCODE_CONFIG_CONTENT` in its environment, whose `mcp.orchestrator.command` is the shim and whose `permission` is `openCodePermission(settings.permission, allowedTools)` for the claim's `allowedTools`, and the launch row carries the usage of the `step_finish` events with `usageSource: "worker"`

#### Scenario: Contended OpenCode start
- **WHEN** the claimed `opencode run` exits with `database is locked` on stderr and no event
- **THEN** the loop logs `startupContended`, releases the launch with `keep: true` so the task returns to `unstarted` with no attempt charged, and claims again after a short back-off

#### Scenario: No launches of the kind
- **WHEN** `orchestrator-work --runner opencode` runs against a daemon whose claimable launches are all `codex`
- **THEN** it leaves them parked and exits once the quiet has lasted `--idle-exit-ms`, logging `nothing claimable for opencode`

#### Scenario: A launch being prepared keeps the loop running
- **WHEN** a `codex` loop finds nothing claimable and nothing live, a question is open, and `status.preparingByKind.codex` is 1
- **THEN** the loop does not stop, also after `--idle-exit-ms`, while an `opencode` loop on the same status stops because the run waits on a human

### Requirement: OpenCode host
`hosts/opencode/` SHALL let an OpenCode session be the operator. It SHALL ship `bin/orchestrator.mjs`, the third copy of the launcher of "Plugin launcher", whose npx fallback is pinned to the version of the published package in `hosts/opencode/package.json`. `hosts/opencode/skills/` SHALL hold `import`, `run`, and `review` skills named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`.

#### Scenario: OpenCode registration verified
- **WHEN** `OPENCODE_CONFIG` names the snippet with `<hosts/opencode>` filled in and `opencode mcp list` is run
- **THEN** it reports `orchestrator_operator` as `connected` with the launcher command

#### Scenario: operator server answers in an OpenCode session
- **WHEN** `opencode run` runs with the snippet as its config and is asked to call `orchestrator_operator_start` with `mode: "spawn"`
- **THEN** its `tool_use` event names `orchestrator_operator_start`, completed, and the result reports `mode: "spawn"`

#### Scenario: Skill editions held in step
- **WHEN** the Codex edition of a skill is changed in a block the OpenCode edition shares
- **THEN** the host test fails until the OpenCode edition carries the same change

#### Scenario: Rewritten block pinned
- **WHEN** a word is changed inside a rewritten block of an OpenCode skill, outside the phrase that names the block
- **THEN** the host test fails, naming the block, until its pinned hash is updated

#### Scenario: Notice appended once
- **WHEN** the plugin sees `session.created` and then two `chat.message` calls for that session while a run needs attention
- **THEN** the first message's text part ends with the start line, the second is untouched, and one toast shows the line

#### Scenario: Nothing needs attention
- **WHEN** the plugin runs with an `ORCH_HOME` that holds no run
- **THEN** the user's message part is unchanged and no toast is shown

#### Scenario: Worker launch not pure
- **WHEN** `runner.opencode.pure` is `false` and an opencode worker launch is composed
- **THEN** the command carries no `--pure`, so a globally installed session plugin loads into the worker unless `runner.opencode.ignoreUserConfig` is `true`

### Requirement: Import skill scope guidance for OpenSpec
The import skill of every host SHALL say that, in a repository with an `openspec/` root, a task that changes a spec lists its change directory `openspec/changes/<name>/**` in Scope, not `openspec/specs/<capability>/spec.md`. When an issue's Scope lists a file under `openspec/specs/`, the skill SHALL tell the user and suggest the change directory; the description is still sent as is.

#### Scenario: Import skill names the change directory
- **WHEN** the import skill of `hosts/claude-code`, `hosts/codex` or `hosts/opencode` is read
- **THEN** its Scope guidance names `openspec/changes/<name>/**` in place of `openspec/specs/<capability>/spec.md`

#### Scenario: Issue scope names a main spec file
- **WHEN** an issue being imported into a repository with an `openspec/` root lists `openspec/specs/worker-runners/spec.md` in its Scope
- **THEN** the skill tells the user and suggests `openspec/changes/<name>/**`, and imports the description unchanged

### Requirement: Codex plugin manifest
`hosts/codex/` SHALL be the Codex plugin `orchestrator-codex`. `hosts/codex/.codex-plugin/plugin.json` SHALL name it `orchestrator-codex`, SHALL carry a `version` equal to the package version, and SHALL point `skills` at `./skills/`, `mcpServers` at `./.mcp.json`, and `hooks` at `./hooks/hooks.json`. A host test SHALL parse the manifest and SHALL fail when its version differs from the package version.

#### Scenario: Plugin version follows the package
- **WHEN** a release bumps `package.json` without `hosts/codex/.codex-plugin/plugin.json`
- **THEN** the host test fails

### Requirement: Codex plugin hooks
`hosts/codex/hooks/hooks.json` SHALL run `hooks/session-start.mjs` (matcher `startup|resume|clear`, ten-second timeout) on `SessionStart` with `node` through `${PLUGIN_ROOT}`.

#### Scenario: Hooks parse
- **WHEN** the host tests read `hosts/codex/hooks/hooks.json`
- **THEN** it declares exactly the two hooks, each command naming its script under `${PLUGIN_ROOT}/hooks/`, SessionStart with timeout 10 and SessionEnd with timeout 3

#### Scenario: SessionStart line through the installed plugin
- **WHEN** `ORCH_E2E_CODEX_HOST=1`, the plugin is installed from the marketplace file into a scratch `CODEX_HOME` whose hooks are not trusted, `ORCH_HOME` holds a run whose daemon exited with two launches parked, and `codex exec --dangerously-bypass-hook-trust` runs without `--ephemeral`
- **THEN** the session's rollout holds one hook additional-context message: the SessionStart line naming that run, with its two parked launches

### Requirement: Codex marketplace file
The repository SHALL contain `.agents/plugins/marketplace.json` at its root, named `orchestrator`, listing only `orchestrator-codex` with `source: { source: "local", path: "./hosts/codex" }`, `policy.installation: "AVAILABLE"`, and category `Developer Tools`. Codex reads this file instead of `.claude-plugin/marketplace.json`, which SHALL keep listing the Claude Code plugin for Claude Code.

#### Scenario: Installed from the marketplace file
- **WHEN** `codex plugin marketplace add <checkout>` runs in a scratch `CODEX_HOME`
- **THEN** `codex plugin list` lists `orchestrator-codex@orchestrator` and no other plugin of that marketplace, and `codex plugin add orchestrator-codex@orchestrator` installs it

### Requirement: Codex plugin MCP server
`hosts/codex/.mcp.json` SHALL declare exactly one server, `orchestrator_operator`, with `command: "node"`, `args: ["./bin/orchestrator.mjs", "mcp"]`, and `cwd: "."`, because Codex resolves `cwd: "."` to the installed plugin root and expands no variable in `args`.

#### Scenario: Server runs from the plugin root
- **WHEN** the plugin is installed and `codex mcp get orchestrator_operator --json` is run
- **THEN** its `cwd` is the installed plugin root, its args are `./bin/orchestrator.mjs` and `mcp`, `startup_timeout_sec` is 60, and `tool_timeout_sec` is 180

#### Scenario: Start through the plugin names the repository
- **WHEN** the installed plugin's launcher runs this checkout's build, its tools are pre-approved under the plugin's key, and `codex exec -C <throwaway repository>` is asked to call `start` with `repo` set to that repository
- **THEN** the `start` call's arguments carry the repository and its result has status 200 and names the repository

#### Scenario: Forwarded variables pinned
- **WHEN** the host tests read `hosts/codex/.mcp.json`
- **THEN** `env_vars` is `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, `CODEX_API_KEY`

### Requirement: Skills pass the repository
The `import`, `run`, and `review` skills of the Codex and OpenCode hosts SHALL tell the model to pass `repo`, the absolute path of the session's working directory, on every operator tool call, because a plugin-installed operator server runs in the plugin's directory and cannot tell the session's project. The instruction SHALL be one paragraph, identical in both editions after the OpenCode substitutions.

#### Scenario: Codex skills pass repo
- **WHEN** the host tests read each Codex skill
- **THEN** it says to pass `repo`, set to the absolute path of this session's working directory, on every operator tool call

#### Scenario: OpenCode edition unchanged otherwise
- **WHEN** the OpenCode host test compares each OpenCode skill with its Codex edition
- **THEN** the `repo` paragraph matches block for block, and only the pinned edition blocks differ

### Requirement: Work loop ends a hung agent
While an agent runs, the work loop SHALL read its launch from `GET /v1/status` every `--poll-ms` and SHALL end the agent's process group (SIGTERM, then SIGKILL after 5 s), logging the reason, when the daemon has ended the launch; when its task reported 30 s ago and the agent has not exited; or when its task is running and the agent has written nothing for longer than the silence limit. Silence SHALL NOT be counted while the task waits on an answer.

#### Scenario: Ended launch
- **WHEN** the worker no longer holds the launch and its task is neither submitted nor done (failed, stuck, lease expired, cancelled, released, or relaunched on another launch)
- **THEN** the loop ends the agent's process group, sending SIGKILL after 5 s even when the shell has already exited

#### Scenario: Daemon unreachable
- **WHEN** `GET /v1/status` fails while the agent runs
- **THEN** only the silence limit applies

#### Scenario: The daemon expires a silent claim
- **WHEN** the claimed agent never writes and never exits, so the loop keeps renewing its lease, and the daemon fails the launch `stuck` (or `leaseExpired`, when the renewals could not reach it) and relaunches the task
- **THEN** the loop logs that the daemon ended the launch, ends the agent's process group, and claims the relaunch

#### Scenario: An agent that reported keeps its last output
- **WHEN** the agent submits and the daemon ends the launch `reported` while the agent is still printing its final events
- **THEN** the loop does not end it for 30 s, so its usage is posted with `usageSource: "worker"`

#### Scenario: Waiting is not silence
- **WHEN** the agent is blocked on a question for longer than the silence limit
- **THEN** the loop does not end it

### Requirement: Work loop silence limit
The work loop's silence limit SHALL follow this rule, in this order. `--max-silence-ms` when given SHALL win and SHALL never be replaced; `--max-silence-ms 0` SHALL turn the limit off. Else, when the claim carries no `health` field, the limit SHALL be 45 minutes (the daemon's default `health.stuckFailAfterMs`) and the loop SHALL NOT read `status` for it. The loop SHALL log one line when its limit changes.

#### Scenario: The claim names no threshold
- **WHEN** the loop runs without `--max-silence-ms` against a daemon whose claim carries no `health`
- **THEN** the silence limit is 45 minutes, whatever `status` says

#### Scenario: Silence past the limit
- **WHEN** the loop runs with `--max-silence-ms 5000` and the claimed agent writes nothing for longer while its task runs and the launch is still held
- **THEN** the loop ends the agent's process group, releases the launch with `keep: false` and a reason naming the silence, and claims the next launch

#### Scenario: A raise during silence
- **WHEN** the loop runs without `--max-silence-ms`, claims under `health.stuckFailAfterMs: 4000`, and the operator raises it to 60000 through `PUT /v1/config` while the agent is silent
- **THEN** the loop logs the new limit, and does not end the agent when 4000ms of silence have passed

#### Scenario: Status names 0
- **WHEN** the loop runs without `--max-silence-ms` and `status` answers `budgets.stuckFailAfterMs: 0`
- **THEN** the silence limit is 45 minutes, not off

#### Scenario: A fixed limit is not replaced
- **WHEN** the loop runs with `--max-silence-ms 4000` and the operator raises `health.stuckFailAfterMs` to 60000 while the agent is silent
- **THEN** the loop ends the agent after 4000ms of silence

#### Scenario: Status cannot be read
- **WHEN** the loop's `status` read fails or answers without a number at `budgets.stuckFailAfterMs`
- **THEN** the silence limit stays what it was

### Requirement: Work loop after ending an agent
After an agent the loop ended has exited, the loop SHALL post its usage as for any exit and SHALL NOT classify its output as a start failure. It SHALL release the launch without keep, with a reason naming the termination, when the worker still holds it, and SHALL NOT release a launch the daemon ended. The outcome SHALL be `hung`, counted toward `--max-failures`, except after a report, when it SHALL be `started`. The loop SHALL then claim again.

#### Scenario: The daemon's verdict stands
- **WHEN** the loop ends an agent whose launch the daemon failed `stuck`
- **THEN** no `operator.release` is recorded for that launch and the outcome is `hung`

#### Scenario: A model that always hangs
- **WHEN** `--max-failures` launches in a row end with the outcome `hung`
- **THEN** the loop stops

### Requirement: Work workflow heartbeat interval
The work workflow's claimer SHALL return the claim's `lease.ttlMs` and `lease.renewEveryMs`. The worker prompt SHALL state both, and SHALL say that only the worker's own calls renew its lease. It SHALL say to call `launch_heartbeat` at least every `renewEveryMs`. It SHALL say to run any command expected to take longer in the background, heartbeating while it runs. The numbers SHALL come from the claim. Without them the prompt SHALL give a rule with no number.

#### Scenario: Prompt names the claimed interval
- **WHEN** a loop claims a launch whose response carries `lease: { ttlMs: 600000, renewEveryMs: 200000 }`
- **THEN** the worker prompt says the lease lasts 600000ms, to call `launch_heartbeat` at least every 200000ms, and to run longer commands in the background

### Requirement: Work loop renews the lease
While a claimed launch's agent process lives, `orchestrator-work` SHALL call `POST /v1/launches/:id/renew` with the launch token every `renewEveryMs` from the claim (else a third of `leaseTtlMs`), with one request in flight. It SHALL stop when the agent process exits, even while another process (a grandchild) still holds its output pipes, and when the process fails to spawn. It SHALL stop for good on 401, 404 or 409. A network error SHALL be a missed beat.

#### Scenario: A silent agent keeps its launch
- **WHEN** the loop runs an agent that writes nothing and calls nothing under `leaseTtlMs: 1500` and `--max-silence-ms 6000`
- **THEN** the daemon does not expire the launch; the loop ends the agent at its silence limit and releases the launch (`endReason: "released"`) no sooner than 6000ms after the claim, and the launch's `progressAt` is still its claim time

#### Scenario: A grandchild holds the pipe
- **WHEN** the agent exits without a report, leaving a grandchild that keeps its stdout open, under `leaseTtlMs: 1500` and `--max-silence-ms 20000`
- **THEN** the loop stops renewing at the exit, the daemon ends the launch with `leaseExpired` well before the silence limit, and the loop does not release it

#### Scenario: A killed loop's claim expires
- **WHEN** the loop process is killed with SIGKILL while its detached agent still runs
- **THEN** the daemon ends the launch with `leaseExpired` within `leaseTtlMs` plus a tick, with margin for load, and the attempt is spent because nothing in the worktree changed

#### Scenario: Renewal stops on refusal
- **WHEN** a renewal answers 401, 404 or 409
- **THEN** the loop sends no further renewal for that launch

### Requirement: Work loop preamble states the interval
The preamble that `orchestrator-work` feeds the agent SHALL state the lease TTL and `renewEveryMs` from the claim. It SHALL say to call an orchestrator tool at least that often and to run longer commands in the background, calling `heartbeat` while they run. It SHALL also say that the loop's renewal keeps the lease but is not progress. Without lease facts in the claim it SHALL carry no lease line.

#### Scenario: Preamble names the claimed interval
- **WHEN** the claim carries `lease: { ttlMs: 600000, renewEveryMs: 200000 }`
- **THEN** the preamble says the lease is 600000ms and to call at least every 200000ms

### Requirement: Run skill handles a Linear project-milestone root
The `run` skill SHALL treat a Linear effect whose `url` is a project URL (its path holds `/project/` and not `/issue/`) as an effect for a project-milestone root. It SHALL never change the project's state: every `setState` effect for such a root SHALL be acknowledged with `ack { id, result: { applied: false, reason } }`. A Linear effect with an issue URL SHALL follow the existing rules.

#### Scenario: Done for a project root
- **WHEN** the outbox lists `setState done` for a root whose `url` holds `/project/`
- **THEN** the skill acknowledges it with `applied: false` and a reason, and the project is unchanged

#### Scenario: In progress for a project root
- **WHEN** the outbox lists `setState inProgress` for a root whose `url` holds `/project/`
- **THEN** the skill acknowledges it with `applied: false` and a reason, and the project is unchanged

#### Scenario: Ready for review comment
- **WHEN** the outbox lists the ready-for-review comment for a root whose `url` holds `/project/`
- **THEN** the skill posts nothing and acknowledges it with `applied: false` and a reason

#### Scenario: Accepted comment
- **WHEN** the outbox lists a comment opening "Milestone accepted:" for a project root
- **THEN** the skill posts a project status update with the body, a blank line and the marker as the last line, and acknowledges with `statusUpdateId`

#### Scenario: Rejected comment
- **WHEN** the outbox lists a comment opening "Milestone rejected:" for a project root
- **THEN** the skill posts a project status update with the body, a blank line and the marker as the last line, and acknowledges with `statusUpdateId`

#### Scenario: Marker already posted
- **WHEN** a recent status update of the project already holds the effect's marker
- **THEN** the skill acknowledges with that update's id and posts no second update

#### Scenario: Issue URL
- **WHEN** a Linear effect has a `url` holding `/issue/`
- **THEN** the skill follows the existing state-type and comment rules

### Requirement: Import skill records a Linear project-milestone root
The `import` skill SHALL state that for a Linear project-milestone root the root record's `url` is the project's URL, its `id` is a short key the user confirms that is safe in a URL path and a git branch name, and its `state` is `open`.

#### Scenario: Project milestone root
- **WHEN** the user imports a Linear project milestone
- **THEN** the root record carries the project's URL as `url`, and the milestone's issues are the children

### Requirement: Work loop silence leaves out a sleep
As an exception to "Work loop ends a hung agent" and "Work loop silence limit", the work loop SHALL leave a sleep of its own machine out of an agent's silence. The loop SHALL note its own clock for each running agent at spawn, every second (or every quarter of the threshold when that is shorter), and immediately before each verdict of the watcher. `--gap-after-ms 0` SHALL turn the rule off.

#### Scenario: A sleep longer than the limit
- **WHEN** the agent wrote output, then the machine slept for twice the silence limit, and the loop notes its clock after the wake
- **THEN** the sleep is left out of the silence, the silence is below the limit, the loop logs the length it left out, and the loop does not end the agent
- **AND** the agent is ended when it then stays silent for the limit while the machine is awake

#### Scenario: Silence while awake
- **WHEN** the machine stays awake and the agent writes nothing for longer than the silence limit, with the loop's notes one second apart
- **THEN** no gap is found, the silence equals the wall time, and the loop ends the agent and releases the launch without keep

#### Scenario: A slow look of the watcher is not a sleep
- **WHEN** the machine is awake and a look of the watcher takes more than a minute because the daemon is unreachable
- **THEN** the per-agent timer's notes stay one second apart, no gap is found, and the silence limit applies as before

#### Scenario: The rule turned off
- **WHEN** the loop runs with `--gap-after-ms 0` and the machine sleeps for twice the silence limit
- **THEN** the sleep counts as silence and the loop ends the agent as it did before this rule

### Requirement: Review skill reads the index then each task
The `review` skill of each host SHALL key its reading on the `view` field of the `review` answer, never on the tool's argument list: read the index, then each closure task with `task`, and judge against that answer's `acceptanceCriteria`. Before deciding it SHALL check that every one-task answer carries the index's `integrationSha` and `reviewVersion`, else start again. Only the Claude Code edition SHALL hold a fan-out sentence, saying each reviewer fetches its own task.

#### Scenario: Index answer
- **WHEN** the answer has `view` `index`
- **THEN** the skill reads `omitted`, fetches each closure task with `task`, says `full` can be too large, and says `diffStat` is cut and runs against the run's baseline

#### Scenario: Answer without view
- **WHEN** the answer has no `view` field
- **THEN** the skill treats it as the whole bundle of an older daemon and says never to call per task

#### Scenario: Index answer and a tool without task
- **WHEN** `view` is `index` and the `review` tool has no `task` argument
- **THEN** the skill fetches `GET <daemonUrl>/v1/milestones/<id>/review?task=<taskId>` with `daemonUrl` from `status`, or updates the plugin

#### Scenario: Refused answer
- **WHEN** the client refuses an answer for its size, in any case
- **THEN** the skill saves it with `curl -s <daemonUrl>/v1/milestones/<id>/review` (`?full=true` for the whole bundle), reads the file in parts, and asks the user to run the command if the session refuses it

#### Scenario: Answer with previous
- **WHEN** the answer has `previous`
- **THEN** the skill reads `git diff <previous.sha>..<integrationSha>` and the tasks in `previous.tasksSince` (every closure task when `previous.tasksSinceUnavailable` is true), and says `accept` covers the whole pinned commit

#### Scenario: Previous version unavailable
- **WHEN** `previous.unavailable` is set
- **THEN** the skill reviews the whole closure as for a first version

#### Scenario: Whole-bundle entry
- **WHEN** the answer is a whole bundle (no `view`, or `view` `full`)
- **THEN** the skill reads each task's criteria from its tracker issue or its one-task answer, since the bundle's `acceptanceCriteria` is the milestone's

#### Scenario: Resubmitted milestone
- **WHEN** a one-task answer carries another `integrationSha` or `reviewVersion` than the index
- **THEN** the skill starts the review again

### Requirement: Run skill offers a raised limit
Each run skill SHALL hold, in its monitor list after the stuck bullet, a bullet that starts with `- **a launch needs more time**`. It SHALL tell the agent to compare, whenever it reads `status`, each running launch's `elapsedMs` in `liveLaunches` with `budgets.maxLaunchMs` when that is above 0, and to tell the user when less than 15 minutes remain, and to offer the same when the user wants a stuck launch to keep running. The stuck bullet SHALL point to the new bullet.

#### Scenario: The bullet in each edition
- **WHEN** the bullet is cut out of each run skill
- **THEN** it holds `configure`, `health.stuckFailAfterMs`, `budgets.maxLaunchMs`, `elapsedMs`, `applied` and `null`; the Claude Code bullet holds `leaseTtlMs`, and the Codex and OpenCode bullets hold `orchestrator-work` and not "this session's workers"

### Requirement: Run skill confirms a lowering with the user
The bullet `- **a launch needs more time**` of each run skill SHALL say that a lowered, cleared or switched-on limit that a live launch is already past is refused with a 409 whose `wouldEnd` lists the launches it would end and that nothing is applied, that the agent shows `wouldEnd` to the user, and that it sends the call again with `endLive: true` only when the user says so. A session SHALL NOT add `endLive` by itself after a 409.

#### Scenario: The refusal is shown
- **WHEN** the bullet is cut out of each run skill
- **THEN** it holds `wouldEnd` and `endLive` and says to send `endLive` only when the user says so

#### Scenario: The confirmed change
- **WHEN** the user, shown `wouldEnd`, says to go on
- **THEN** the skill has the agent send the same call with `endLive: true`

#### Scenario: Clearing a raise
- **WHEN** the agent clears a raise with a null leaf once a launch has reported, and another live launch relies on the raise
- **THEN** the 409 with `wouldEnd` is shown to the user, and `endLive` is sent only on the user's say

### Requirement: Run skill: workers are told of a limit change
The bullet **a launch needs more time** of each run skill SHALL say that the daemon tells each affected worker of a changed limit through its inbox, as a `nudge` notice the worker sees on its next inbox call, and SHALL NOT tell the session to send a nudge with the new limit. The Claude Code edition SHALL keep its sentence on the lease of this session's workers.

#### Scenario: The session does not send the new limit
- **WHEN** the session raises `budgets.maxLaunchMs` for a launch that needs more time
- **THEN** the skill tells it that the daemon has told the worker through its inbox, and does not tell it to `nudge` the worker

#### Scenario: A loop started with a fixed limit
- **WHEN** the session raises `health.stuckFailAfterMs` for a launch held by an `orchestrator-work` loop
- **THEN** the Codex and OpenCode skills say the loop follows the new limit unless it was started with `--max-silence-ms`

### Requirement: Run skill asks for a held profile
Each run skill (Claude Code, Codex, OpenCode) SHALL hold one paragraph that starts with `**Worker profile.**`, directly after the paragraph that starts "Tell the user who is executing the work". No existing paragraph or bullet SHALL change, and the Codex and OpenCode blocks SHALL be equal after the edition substitutions.

#### Scenario: The paragraph read alone

- **WHEN** the **Worker profile.** paragraph is cut out of any of the three run skills
- **THEN** it holds `confirmProfile`, `status.profiles`, `held`, `missing`, `modelSource`, `configure`, `runner.confirmProfile`, `orchestrator.yaml` and the words "model of this session"

#### Scenario: The work skill bullet

- **WHEN** the **Worker profile.** bullet is cut out of the Claude Code work skill
- **THEN** it holds `status.profiles` and `held: true`

### Requirement: Import skill reports held tasks
Each import skill SHALL hold one paragraph in section 5 that starts with `**Held tasks.**`, directly before "Then offer to run it": the session calls `status` after the import and, when `status.profiles` has an entry with `held: true`, tells the user how many tasks are held and that the daemon will not launch them, asks for the keys in `missing` and applies the answer with `configure`, never choosing from the model of this session.

#### Scenario: The blocks read alone

- **WHEN** the **Worker profile.** bullet and the **Held tasks.** paragraph are cut out of any of the three import skills
- **THEN** the bullet holds `confirmProfile`, `default` and `configure`
- **AND** the paragraph holds `status.profiles`, `held`, `missing`, `configure` and the words "model of this session"

### Requirement: Run skill names the Codex network access override

The paragraph of each run skill (Claude Code, Codex and OpenCode editions) that lists what `configure` also takes SHALL name `networkAccess` (`codex.networkAccess`, `true` or `false`, for launches spawned or claimed after the change), SHALL say that it widens what a Codex worker can reach, and SHALL say that it is set only when the user says so. The Codex and OpenCode editions SHALL use the same words. The skills SHALL NOT offer the key as a remedy for a `needsAccess` question.

#### Scenario: The configure paragraph names the key and its risk
- **WHEN** a run skill is split at blank lines and the block that holds `` `configure` also takes `` is read with its whitespace collapsed
- **THEN** it holds `networkAccess`, `widens what a Codex worker can reach` and `only when the user says so`

#### Scenario: The session does not choose network access itself
- **WHEN** a Codex worker asks with `needsAccess` for a command that needs the network
- **THEN** the run skill does not tell the session to set `networkAccess`
- **AND** the session sets it only when the user says so

### Requirement: Package entrypoints: publishable package
The package SHALL be publishable as `@autodidacticon/orchestrator`: not `private`, with `publishConfig.access` `public`, `prepublishOnly` running the build, and `files` covering `dist/src`, `hosts`, and `README.md`.

#### Scenario: Package manifest is publishable
- **WHEN** `package.json` is read
- **THEN** its `name` is `@autodidacticon/orchestrator`, it has no `private` field, `publishConfig` is `{ access: "public" }`, `scripts.prepublishOnly` is `npm run build`, and `files` lists `dist/src`, `hosts`, and `README.md`

### Requirement: Package entrypoints: wrappers reach the package through the launcher
Host wrappers SHALL NOT reference executables by name on PATH; they SHALL reach the package through the plugin launcher, which resolves a checkout or the published package.

#### Scenario: Operator server started through the launcher
- **WHEN** `hosts/claude-code/.mcp.json` is read
- **THEN** the `operator` server's command is `node` with the plugin's `bin/orchestrator.mjs`, and no package executable such as `orchestrator-mcp` is named as the command

### Requirement: Per-host wrappers: Claude Code plugin layout
The first host SHALL be `hosts/claude-code/`, a Claude Code plugin named `orchestrator` with `.claude-plugin/plugin.json`, an `.mcp.json` declaring a server `operator` that runs `node ${CLAUDE_PLUGIN_ROOT}/bin/orchestrator.mjs mcp` with a tool-call `timeout` above the `wait` cap, hooks under `hooks/`, and skills under `skills/`. The plugin SHALL pass `claude plugin validate --strict` and SHALL load with `claude --plugin-dir hosts/claude-code`.

#### Scenario: Plugin directory contents
- **WHEN** `hosts/claude-code` is listed
- **THEN** `.claude-plugin/plugin.json` names the plugin `orchestrator`, and the directory holds `.mcp.json`, `hooks/hooks.json`, and the skills `import`, `run`, `review`, and `work` under `skills/`

### Requirement: Per-host wrappers: plugin package manifest
The plugin directory SHALL contain a private `package.json`, named for the plugin and not for the orchestrator package, whose only dependency is the published package pinned to the exact version in `.claude-plugin/plugin.json` (no range operator), together with a committed `package-lock.json` of lockfile version 2 or 3 that resolves exactly that dependency, so that a marketplace install triggers Claude Code's automatic dependency install into `${CLAUDE_PLUGIN_ROOT}/node_modules`.

#### Scenario: Plugin package named for the plugin
- **WHEN** `hosts/claude-code/package.json` is read
- **THEN** its `name` is `orchestrator-claude-code-plugin`, not `@autodidacticon/orchestrator`, and its dependency on `@autodidacticon/orchestrator` is an exact version with no range operator

### Requirement: Per-host wrappers: plugin dependencies
The plugin directory's `package.json` SHALL declare no other dependency, and the plugin's `node_modules` SHALL be ignored by git.

#### Scenario: Only the package, and no installed tree in git
- **WHEN** the host tests read `hosts/claude-code/package.json` and `.gitignore`
- **THEN** the manifest's only dependency key is `@autodidacticon/orchestrator`, `.gitignore` lists `hosts/claude-code/node_modules/`, and no `hosts/claude-code/node_modules` is committed

### Requirement: Skills: import requires a tracker connector
`import` SHALL require a tracker connector: a Linear or Atlassian MCP server, or GitHub through a `gh` CLI whose `gh auth status` succeeds or a GitHub MCP server; it SHALL refuse with a clear message naming the three options otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria.

#### Scenario: Import skill names the connectors
- **WHEN** `hosts/claude-code/skills/import/SKILL.md` is read
- **THEN** it names the Linear and Atlassian MCP servers, a GitHub MCP server, and `gh auth status` as the connectors, tells the session to stop without calling `import_issues` when none is available, and tells it to report the tasks missing acceptance criteria after the import

### Requirement: Skills: run starts the workflow
`run` SHALL call `start`. When the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, `run` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag.

#### Scenario: Workflow before the first wait
- **WHEN** `hosts/claude-code/skills/run/SKILL.md` is read
- **THEN** it tells the session to call `start` and, when the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, to run the bundled workflow before the first `wait` with a worker count no larger than `capacity` and a run tag

### Requirement: Skills: run monitor loop
`run` SHALL then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report.

#### Scenario: Milestone review from the loop
- **WHEN** `wait` returns a digest whose `awaitingReview` lists MVP during the run skill
- **THEN** the skill invokes the review skill for MVP before waiting again

### Requirement: Skills: run says who executes the work
`run` SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative.

#### Scenario: Executor named at start
- **WHEN** `hosts/claude-code/skills/run/SKILL.md` is read
- **THEN** it tells the session to tell the user who is executing the work, and names `spawn` as an explicit choice made through `start` with `mode` or `runner.mode` in `orchestrator.yaml`

### Requirement: Skills: codex launches need spawn or mixed
The `run`, `work`, and `import` skills SHALL state that codex launches are worked only in `spawn` or `mixed` mode, because pull-mode workers are the session's Claude subagents. `run` SHALL NOT start the workflow for a run whose runner kind is `codex` unless its graph has `claude-code` tasks or `claimableByKind["claude-code"]` is above zero.

#### Scenario: Three skills state the rule
- **WHEN** the `run`, `work`, and `import` skills of `hosts/claude-code` are read
- **THEN** each says that codex launches are worked only in `spawn` or `mixed` mode because pull-mode workers are the session's Claude subagents

### Requirement: Skills: review decides with a note
`review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note.

#### Scenario: Review skill accepts or rejects
- **WHEN** `hosts/claude-code/skills/review/SKILL.md` is read
- **THEN** it tells the session to call `review`, judge each task's report against its `acceptanceCriteria`, and call `accept` with the reviewed `integrationSha` and `reviewVersion` or `reject` with a note saying what is missing

### Requirement: Skills: work adds workers or switches the mode
`work` SHALL remain the explicit way to add workers from a session or to switch the mode.

#### Scenario: Work skill purpose
- **WHEN** `hosts/claude-code/skills/work/SKILL.md` is read
- **THEN** its description says it adds this session's subagents as workers to a run or switches the run's mode, and its prerequisites switch a running daemon with `start` and `mode: "pull"` or `mode: "mixed"`

### Requirement: Skills: Codex edition and its discovery
The Codex host's edition of `import`, `run`, and `review` SHALL follow the rules of "Skills" with the differences stated under "Codex host", and has no `work` skill. Codex SHALL find that edition where it discovers skills: each skill linked or copied as `~/.codex/skills/<name>` (under `CODEX_HOME`), or as `.agents/skills/<name>` in a target repository that vendors them.

#### Scenario: Codex edition has no work skill
- **WHEN** `hosts/codex/skills` is listed
- **THEN** it holds `import`, `run`, and `review` and no `work`

### Requirement: Skills: Codex README documents discovery
`hosts/codex/README.md` SHALL document both places, `~/.codex/skills/<name>` and `.agents/skills/<name>`, and SHALL say that a `[[skills.config]]` entry with a `path` only selects a skill Codex has already discovered (for example to disable it) and does not load one.

#### Scenario: README names both places
- **WHEN** `hosts/codex/README.md` is read
- **THEN** it links each skill as `~/.codex/skills/orchestrator-<name>`, says a target repository can put them in its own `.agents/skills/`, and says that `[[skills.config]]` entries with a `path` do not add a skill

### Requirement: Skills: OpenCode edition and its discovery
The OpenCode host's edition of `import`, `run`, and `review` SHALL follow the same rules of "Skills" with the differences stated under "OpenCode host". OpenCode SHALL find it where it discovers skills: each skill linked or copied as `~/.agents/skills/orchestrator-<name>`, or as `.opencode/skills/orchestrator-<name>` in a repository; `hosts/opencode/README.md` SHALL document both, and SHALL say not to link the Codex edition, which has the same names, into `~/.agents/skills` as well.

#### Scenario: OpenCode README warns against the Codex edition
- **WHEN** `hosts/opencode/README.md` is read
- **THEN** it links each skill as `~/.agents/skills/orchestrator-<name>`, names a project's `.opencode/skills/<name>`, and says not to link the Codex edition into `~/.agents/skills` as well

### Requirement: Skills: no PATH and digests only
No skill SHALL instruct the user to put the package on PATH. Skills SHALL keep digests, not raw events, in the conversation.

#### Scenario: Digests in the conversation
- **WHEN** the skills of `hosts/claude-code` are read
- **THEN** none tells the user to put the package on PATH, and the run skill says to report digests, never raw event lists

### Requirement: Import skill: GitHub root and children
For GitHub the `import` skill SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state.

#### Scenario: Blocker outside the child set fetched
- **WHEN** a sub-issue of the GitHub root is blocked by an issue that is not a child of the root
- **THEN** the skill fetches that blocker for its state and sends a record for it beside the children

### Requirement: Import skill: GitHub record ids
For GitHub the `import` skill SHALL build records as follows: ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`.

#### Scenario: Issue in the tracker's repository
- **WHEN** the tracker is `{ kind: github, workspace: "acme/app" }` and a child is `acme/app#12`
- **THEN** its record's `id` is `GH-12` and its `url` is the issue's URL

### Requirement: Import skill: GitHub record fields
For GitHub the `import` skill SHALL build records as follows: `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through.

#### Scenario: Duplicate with a priority label
- **WHEN** a child is closed with reason `DUPLICATE` and carries the label `priority:2`
- **THEN** its record has `state` `cancelled`, `priority: 2`, and `labels: ["priority:2"]`

### Requirement: Import skill: offer an in-progress label
When a repository has a label that looks like an in-progress marker and none is configured, the skill SHALL offer it.

#### Scenario: Label offered before the import
- **WHEN** no in-progress label was given and the GitHub repository has a label `status: in progress`
- **THEN** the skill offers that label to the user before calling `import_issues`

### Requirement: Import skill: no empty epic
When the root has no sub-issues or milestone issues the skill SHALL say so and SHALL NOT import an empty epic.

#### Scenario: Root without sub-issues
- **WHEN** the GitHub root issue has no sub-issues
- **THEN** the skill tells the user so and does not call `import_issues`

### Requirement: Import skill: re-import sends current states
A re-import after the run has published tasks SHALL send the tracker's current states as they are: the daemon accepts a published task becoming a done external, and a task the tracker shows reopened is not reopened by import but by `reopen`.

#### Scenario: Published task closed in the tracker
- **WHEN** the run has published T1 and a re-import sends T1's issue with state `done`
- **THEN** the daemon accepts T1 becoming a done external node, and the skill sends the state as the tracker shows it

### Requirement: Run skill mirrors: Linear and Jira states
The `run` skill SHALL map `setState` by state type, never by name: for Linear the workflow state of type `started`, `completed`, or `canceled`; for Jira a transition to a status in the category In Progress or Done, and to a canceled-type status when the workflow has one. When the tracker has no canceled-type state the skill SHALL leave the state and post a comment saying the task was cancelled.

#### Scenario: Linear done by type
- **WHEN** the outbox lists `setState done` for ENG-12 on a Linear team whose completed-type state is named "Shipped"
- **THEN** the skill moves ENG-12 to "Shipped" and acknowledges the effect

### Requirement: Run skill mirrors: GitHub states
The `run` skill SHALL map `setState` by state type, never by name: for GitHub, acting on the effect's `url`, `done` closes the issue with reason `completed`, `cancelled` closes it with reason `not planned`, both removing the policy's `inProgressLabel` when the issue carries it, and `inProgress` reopens the issue when it is closed and adds the label, or is acknowledged as skipped when no label is configured.

#### Scenario: Cancelled without a configured label
- **WHEN** the outbox lists `setState cancelled` for `GH-43` under a policy with no `inProgressLabel`
- **THEN** the skill closes `#43` with reason `not planned`, removes no label, and acknowledges the effect

### Requirement: Run skill mirrors: GitHub milestone root
For a GitHub milestone root, `done` SHALL close the milestone and `comment` effects SHALL be acknowledged as skipped.

#### Scenario: GitHub milestone root done
- **WHEN** the outbox lists `setState done` and a `comment` for the milestone root `GH-M3`
- **THEN** the skill closes the milestone, acknowledges the comment as skipped, and posts nothing

### Requirement: Run skill mirrors: comments posted once
Before posting a `comment` the `run` skill SHALL list the issue's recent comments and, if one carries the effect's marker, SHALL `ack` with that comment's id instead of posting; otherwise it SHALL post the body with the marker as the last line and `ack` with the new comment's id.

#### Scenario: Comment posted with its marker
- **WHEN** the outbox lists a `comment` for ENG-13 and no comment on ENG-13 carries its marker
- **THEN** the skill posts the body with the marker as its last line and acknowledges with the new comment's id

### Requirement: Run skill mirrors: answers from comments
When the policy's `answersFromComments` is true, the skill SHALL then, for every task in `openQuestions`, read the issue's comments, ignore any carrying the orchestrator marker, and relay through `answer` the first human comment posted after the latest marked comment that it has not relayed before, remembering what it relayed. An `answer` the daemon refuses with 409 because the task is no longer `waiting` or `blocked` SHALL be reported to the user and not retried.

#### Scenario: Marked comments ignored
- **WHEN** `answersFromComments` is true, ENG-12 has an open question, and the only comment after the question carries the orchestrator marker
- **THEN** the skill relays nothing for ENG-12

### Requirement: Run skill mirrors: GitHub proposal issue
On accepting a proposal in a GitHub run the skill SHALL create the issue as a sub-issue of the root, add a dependency on the proposing task's issue, and pass `GH-<number>` as `nodeId`.

#### Scenario: Sub-issue blocked by the proposer
- **WHEN** the user accepts a proposal from `GH-41` in a GitHub run rooted at `GH-40`
- **THEN** the skill creates the issue with `--parent` naming `#40`, adds `#41` as its blocker, and passes `GH-<new number>` as `nodeId`

### Requirement: Run skill mirrors: payloads stay out of the conversation
The skill SHALL keep effect payloads out of the conversation except for a one-line count of what it applied.

#### Scenario: One-line count
- **WHEN** a drain applies two effects and one is rejected
- **THEN** the skill reports one line "tracker: applied 2, rejected 1" and no effect payload

### Requirement: Run skill proposals: accepting creates the node
On acceptance in a run imported from a tracker, the skill SHALL create the issue through the session's tracker tools as a child of the epic, blocked by the proposing task's issue, with a description that carries the acceptance criteria under the configured heading, and SHALL call `accept_proposal` with the new issue's identifier as `nodeId`. In a file-based run the skill SHALL call `accept_proposal` without `nodeId`.

#### Scenario: Jira acceptance
- **WHEN** the run was imported from Jira and the user accepts `T2-p1`
- **THEN** the skill first creates a Jira issue under the epic, blocked by T2's issue, with the criteria under the configured heading, then calls `accept_proposal` with that issue's key as `nodeId`

### Requirement: Run skill proposals: rejection
On rejection the run skill SHALL call `reject_proposal` with the user's note.

#### Scenario: Rejected with a note
- **WHEN** the user rejects `T2-p1` saying "out of scope"
- **THEN** the skill calls `reject_proposal` for `T2-p1` with the note "out of scope"

### Requirement: Run skill proposals: reopen with blockers
When the user asks to reopen a task and `reopen` returns `blockers`, the skill SHALL show the blockers, offer `cascade`, and show the returned plan.

#### Scenario: Cascade plan shown
- **WHEN** `reopen` of T1 was refused with `blockers` [T2] and the user agrees to the cascade
- **THEN** the skill calls `reopen` with `cascade: true` and shows the returned plan

### Requirement: Work skill: starting the workflow
The `work` skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag.

#### Scenario: Capacity passed to the workflow
- **WHEN** `hosts/claude-code/skills/work/SKILL.md` is read
- **THEN** it tells the session to call `start` and `status`, use the `import` skill first when no graph is loaded, and run the workflow with `workers`, `runTag`, and `capacity` taken from `status.config.capacity.value`

### Requirement: Work skill: after the workflow returns
When the workflow returns, the `work` skill SHALL: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable and nothing being prepared (`claimable` and `preparing` are 0).

#### Scenario: Finished run ends the skill
- **WHEN** the digest reports `finished` true after the workflow has returned
- **THEN** the skill reports the final state and stops looping

### Requirement: Work skill: codex launches left to the daemon
The `work` skill SHALL say that pull-mode workers are this session's Claude subagents, which claim only `claude-code` launches, so that codex launches are worked only in `spawn` or `mixed`; when only codex launches are parked it SHALL offer `start` with `mode: "spawn"` or `"mixed"` instead of running the workflow.

#### Scenario: Only codex launches parked
- **WHEN** `status.claimableByKind["claude-code"]` is 0 and only codex launches are parked
- **THEN** the work skill runs no workflow and offers `start` with `mode: "spawn"` or `"mixed"`

### Requirement: Work workflow: claims only claude-code launches
The workflow SHALL claim with `runner: "claude-code"`, so that codex-kind launches are never claimed by the Claude worker loop, and its stop rule SHALL count only `claimableByKind["claude-code"]` and `preparingByKind["claude-code"]` (0 when the status has no `preparingByKind`).

#### Scenario: Claim names the runner
- **WHEN** the claimer prompt of `workflows/work.js` is composed
- **THEN** its claim step passes `runner "claude-code"`, and its stop rule reads `claimableByKind["claude-code"]` and `preparingByKind["claude-code"]`, 0 when status has no `preparingByKind`

### Requirement: Work workflow: clamp and fan-out
The workflow SHALL clamp the worker count to the `capacity` argument when one is given, logging the clamp, and SHALL fan out one loop per worker with `parallel`.

#### Scenario: No capacity given
- **WHEN** the workflow runs with `workers: 3` and no `capacity`
- **THEN** three loops run in `parallel` and nothing about a clamp is logged

### Requirement: Work workflow: claimer agent
Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, read `status`, evaluate the stop rule, and claim again, up to three polls before returning without a launch.

#### Scenario: Claimer options
- **WHEN** the workflow runs with `claimEffort: "medium"` and no `claimModel`
- **THEN** every claimer agent is started with model `claude-haiku-5-5` and effort `medium`, labelled `claim <workerId>`, and its prompt waits with `until "any"` and `timeoutMs` 90000 before reading `status`

### Requirement: Work workflow: worker agent
On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions.

#### Scenario: Brief in the prompt
- **WHEN** a claim returns `briefMarkdown` for KNO-10
- **THEN** the worker agent's prompt holds that brief after the tool instructions, and the agent is labelled `work <workerId> KNO-10`

### Requirement: Work workflow: worker tool instructions
On a claim the loop SHALL run a worker agent whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401.

#### Scenario: Prompt rules
- **WHEN** the worker prompt of `workflows/work.js` is composed for a claim
- **THEN** it says to commit on the launch branch, to call `launch_block` again with the same seq while pending, to commit and call again with the same seq on a 409 `dirtyWorktree`, never to write a fallback report file, and to stop on 401

### Requirement: Work workflow: loop end
A loop SHALL end when nothing is claimable, nothing is being prepared for `claude-code`, no loop holds a launch, and the digest reports finished, stalled, or an open question.

#### Scenario: Held launch keeps the loops going
- **WHEN** nothing is claimable or being prepared and a question is open, while another loop holds a launch
- **THEN** the claimer's stop is false and it polls again

### Requirement: Work skill: claimer options and worktree access
The `work` and `run` skills SHALL document `claimModel` and `claimEffort` with their defaults and pass them only when the user asks for a different claimer, and SHALL say that workers edit worktrees under the run directory, outside the repository, so a session in `acceptEdits` mode prompts for each file there unless started with `--add-dir` for that directory.

#### Scenario: Both skills document the claimer and the run directory
- **WHEN** the `work` and `run` skills of `hosts/claude-code` are read
- **THEN** each names `claude-haiku-5-5` at `low` as the claimer default, says to pass `claimModel` and `claimEffort` only when the user asks, and says an `acceptEdits` session prompts for files under the run directory unless started with `--add-dir ~/.orchestrator`

### Requirement: Work skill: workflow script passed inline
The `work` and `run` skills SHALL tell the session to read `workflows/work.js` from the plugin directory and pass its whole text as the Workflow tool's `script` input with the workflow's `args`, because the Workflow tool refuses a `scriptPath` outside the working directory and added directories.

#### Scenario: Script input named
- **WHEN** the `work` and `run` skills of `hosts/claude-code` are read
- **THEN** each shows a Workflow call whose `script` is the whole text of `<plugin dir>/workflows/work.js` and says why a `scriptPath` with the plugin path is refused

### Requirement: Work skill: scriptPath as the alternative
The `work` and `run` skills SHALL present `scriptPath` with the plugin path only as an alternative when the plugin directory has been added with `/add-dir`, and SHALL say that after one inline run the tool returns a saved script path that a re-run with the same run tag may use.

#### Scenario: Added plugin directory
- **WHEN** a session has added the plugin directory with `/add-dir` and runs the work skill
- **THEN** the skill may pass `scriptPath: "<plugin dir>/workflows/work.js"` with the same `args`, and a re-run with the same run tag may pass the saved script path the first inline run returned

### Requirement: Marketplace manifest: self-contained install
Because a marketplace install copies only the plugin directory, the installed plugin SHALL be self-contained: the plugin-local install from its `package.json` and lockfile SHALL provide the package, and the launcher SHALL fall back to the published package at the plugin manifest's version through `npx` when that tree is missing or incomplete.

#### Scenario: Incomplete plugin-local tree
- **WHEN** a copied plugin directory has `node_modules/@autodidacticon/orchestrator` without `dist` and the launcher is asked for `mcp` in dry-run mode
- **THEN** it resolves to `npx` with `--package=@autodidacticon/orchestrator@<plugin manifest version>`

### Requirement: Marketplace manifest: versions agree
The plugin manifest version, the package version, and the pin in the plugin's `package.json` SHALL be equal, the launcher's package name and the pinned dependency SHALL equal the package name `@autodidacticon/orchestrator`, the lockfile SHALL be present and consistent with the pin, and a test SHALL assert all of it.

#### Scenario: Version bump without the pin
- **WHEN** `package.json` is given a new version while `hosts/claude-code/.claude-plugin/plugin.json` and the plugin's pin keep the old one
- **THEN** the host tests fail

### Requirement: Marketplace manifest: plugin validates with every part
The plugin SHALL still pass `claude plugin validate --strict` with the work skill, the workflow, the launcher, the plugin manifest, and the hooks present.

#### Scenario: Work skill and workflow present
- **WHEN** the host tests run
- **THEN** they find `hosts/claude-code/skills/work/SKILL.md` and `hosts/claude-code/workflows/work.js`, and run `claude plugin validate --strict hosts/claude-code` when the `claude` CLI is installed, expecting "Validation passed"

### Requirement: No native dependencies: Postgres driver
The Postgres driver `pg` is allowed because it is pure JavaScript (its dependencies, including the optional `pg-cloudflare`, carry no install script); its optional native peer `pg-native` SHALL NOT be a dependency or be installed.

#### Scenario: pg without pg-native
- **WHEN** `package.json` is read
- **THEN** `pg` is in `dependencies` and `pg-native` is in neither `dependencies` nor `optionalDependencies`

### Requirement: No native dependencies: built-in SQLite
The store SHALL use Node's built-in `node:sqlite` binding, and `engines.node` SHALL be `>=22.13.0`, the first release that loads `node:sqlite` without a flag.

#### Scenario: No SQLite package
- **WHEN** `package.json` is read
- **THEN** `better-sqlite3` is not a dependency and `engines.node` is `>=22.13.0`

### Requirement: Plugin launcher: checkout source
The plugin launcher SHALL run the corresponding package executable from the first of three sources that applies: (a) a repository checkout, recognised when the plugin directory's grandparent holds a `package.json` whose `name` is the published package name `@autodidacticon/orchestrator`, running `dist/src/<entry>.js` when present and otherwise the TypeScript entry through the checkout's `tsx` loader.

#### Scenario: Checkout dry run
- **WHEN** the launcher in `hosts/claude-code/bin/` of a built checkout runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp`
- **THEN** it prints source `checkout` with the checkout's `dist/src/operator/mcp.js` as the first argument

### Requirement: Plugin launcher: plugin-local source
The plugin launcher SHALL run the corresponding package executable from the first of three sources that applies: (b) the plugin-local copy, `<plugin>/node_modules/<name>/dist/src/<entry>.js`, when that file exists.

#### Scenario: Plugin-local ctl
- **WHEN** the plugin directory is copied outside any checkout with `node_modules/<name>/dist/src/operator/cli.js` present and the launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `ctl`
- **THEN** it prints source `plugin` with `node` and that file as the command

### Requirement: Plugin launcher: npx source
The plugin launcher SHALL run the corresponding package executable from the first of three sources that applies: (c) the published package through `npx --yes --package=<name>@<version> <executable>`, using the `npx` beside the running Node and the version from `.claude-plugin/plugin.json`, when the plugin-local tree is missing or incomplete.

#### Scenario: npx beside Node
- **WHEN** the plugin directory is copied outside any checkout without `node_modules` and the launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `daemon`
- **THEN** it prints source `npx`, the command is the `npx` in the running Node's directory when that file exists, and the arguments are `--yes`, `--package=<name>@<plugin manifest version>`, and `orchestrator`

### Requirement: Plugin launcher: Node floor
Before spawning, the plugin launcher SHALL compare `process.versions.node` with the package's `engines.node` floor and, when the running Node is older, SHALL print one line naming the running version and the floor to stderr and exit 1, so that a Node too old for `node:sqlite` fails with a readable message rather than `ERR_UNKNOWN_BUILTIN_MODULE`.

#### Scenario: Old Node in a dry run
- **WHEN** the launcher runs with `ORCH_LAUNCHER_NODE_VERSION` `22.0.0` and `ORCH_LAUNCHER_DRY_RUN` set
- **THEN** it exits 1 with one stderr line naming `22.0.0` and `22.13.0`, and prints nothing to stdout

### Requirement: Plugin launcher: spawn and dry run
The plugin launcher SHALL spawn the resolved command with inherited stdio, forward `SIGTERM`, `SIGINT`, and `SIGHUP`, exit with the child's code, and, when `ORCH_LAUNCHER_DRY_RUN` is set, print the chosen source (`checkout`, `plugin`, or `npx`) and the resolved command as JSON instead of running it.

#### Scenario: Dry run prints JSON
- **WHEN** the launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp --help`
- **THEN** it prints one JSON line with `source`, `command`, and `args` ending in `--help`, and starts no process

### Requirement: Plugin launcher: package name constant
The package name constant in the launcher SHALL equal `package.json` `name`, and a host test SHALL assert it.

#### Scenario: Constant matches the manifest
- **WHEN** the host tests read `hosts/claude-code/bin/orchestrator.mjs` and `package.json`
- **THEN** the launcher's `PACKAGE_NAME` equals `package.json` `name`, `@autodidacticon/orchestrator`

### Requirement: Plugin launcher: daemon and shim from the same tree
The daemon and the agent shim SHALL keep resolving from the tree the server runs in, so that a launcher-started server spawns a daemon from the same checkout, the same plugin-local tree, or the same `npx` installation.

#### Scenario: Daemon beside the server's tree
- **WHEN** an operator server that runs from `<tree>/dist/src/operator/mcp.js` starts a daemon
- **THEN** `daemonCommand()` resolves `<tree>/dist/src/main.js` beside its own module and runs it with the server's Node, so the daemon comes from the same tree as the server

### Requirement: Plugin launcher: host copies
The Codex host and the OpenCode host SHALL each ship a copy, `hosts/codex/bin/orchestrator.mjs` and `hosts/opencode/bin/orchestrator.mjs`, that differs from the plugin's only in the version source of (c), the published package through `npx`: the published package's dependency pin in that host's own `package.json`, never `.claude-plugin/plugin.json`. The two host copies SHALL be identical but for comments, and a host test SHALL assert both facts.

#### Scenario: Codex copy pinned by its package
- **WHEN** `hosts/codex` is copied outside any checkout without `node_modules` and its launcher runs with `ORCH_LAUNCHER_DRY_RUN` set and `mcp`
- **THEN** it prints source `npx` with `--package=<name>@<the version in hosts/codex/package.json>`

### Requirement: Session start hook: Codex and OpenCode
The Codex host declares `hooks/session-start.mjs` as `[[hooks.SessionStart]]` with the same matcher as the Claude Code plugin in `hosts/codex/config.toml`, which SHALL also set `features.hooks = true` and say that Codex runs a hook only once it is trusted. OpenCode has no hook configuration, so the OpenCode host runs the script from its plugin on `session.created` ("OpenCode host").

#### Scenario: Codex template
- **WHEN** `hosts/codex/config.toml` is read
- **THEN** it sets `hooks = true` under `[features]`, declares `[[hooks.SessionStart]]` with matcher `startup|resume|clear` running `node` on `hooks/session-start.mjs` with timeout 10, and says Codex runs a hook only once it is trusted

### Requirement: Session start hook: one script, no package code
The hosts' copies of `hooks/session-start.mjs` SHALL be identical. The session start script SHALL load no package code, SHALL need nothing on PATH but `node`, and SHALL exit 0 whatever happens.

#### Scenario: Unreadable home
- **WHEN** the script runs with `ORCH_HOME` naming a directory that has no `runs` directory
- **THEN** it prints nothing and exits 0

### Requirement: Session start hook: reading runs
The session start script SHALL read every run directory under `ORCH_HOME` (default `~/.orchestrator`), and SHALL probe an alive daemon with `GET /v1/status?probe=1` and a one-second timeout.

#### Scenario: Alive daemon that does not answer
- **WHEN** a run's daemon process is alive but `GET /v1/status?probe=1` does not answer within one second
- **THEN** the line names the run as `daemon alive, not answering`

### Requirement: Session start hook: the line
The session start script SHALL print one line naming each run whose daemon is alive (with its running, waiting, parked, attached, awaiting-review, and open-question counts) or whose daemon is dead with an exit record showing parked launches, open questions, a milestone awaiting review, or a stall (with the exit reason and age) or with no exit record (as not stopped cleanly), ending with how to continue, and SHALL print nothing when no run qualifies.

#### Scenario: Stalled run after an exit
- **WHEN** a run's daemon exited with its exit record's digest showing a stall
- **THEN** the line names the run, the exit reason, its age, and `stalled`, and ends with "Use the run skill in that repository to continue."

### Requirement: Session end hook: the reason
The session end script SHALL read the hook input for `reason`, and SHALL use `sessionEnded` when the input has none or is not JSON. The hook is not needed to release a session's launches. The operator server ends its own attachment when its stdio closes, and the daemon ends attachments whose first pid is dead (operator-control "Session attachments"). What the hook adds is the host's reason.

#### Scenario: Input that is not JSON
- **WHEN** the hook runs with stdin `not json` while a daemon is alive
- **THEN** it posts `reason` `sessionEnded` with its ancestry to that daemon and exits 0

### Requirement: Session end hook: posting the ancestry
The hosts' copies of `hooks/session-end.mjs` SHALL be identical. The session end script SHALL collect its own ancestor process ids up to six levels within 300 ms, SHALL post `{ pids, reason }` to `POST /v1/attachments/ended` of every alive daemon under `ORCH_HOME` in parallel with 400 ms timeouts, SHALL NOT wait for any release, and SHALL exit 0 within the SessionEnd budget whatever happens. The session end script SHALL load no package code.

#### Scenario: Own pid first
- **WHEN** the hook posts to an alive daemon
- **THEN** the body's `pids` starts with the hook's own pid followed by its parent's, and holds at most seven ids

### Requirement: Toolchain report: defaults by kind
The default named in the toolchain line SHALL be the one of the kind in force: `claude-opus-5-5` at `medium` for `claude-code`, `gpt-6-astra` at `medium` for `codex`, `anthropic/claude-opus-5-5` at `medium` for `opencode`.

#### Scenario: Defaults named per kind
- **WHEN** the `run` and `work` skills of `hosts/claude-code` are read
- **THEN** each names `claude-opus-5-5`, `gpt-6-astra`, and `anthropic/claude-opus-5-5`, each at `medium`, as the defaults for `claude-code`, `codex`, and `opencode`

### Requirement: Toolchain report: allow-list and model parts
For a `claude-code` run whose daemon spawns agents, the toolchain line SHALL also name the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node"). When launches are worked by session subagents the allow-list part of the toolchain report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted.

#### Scenario: Runner command without a model slot
- **WHEN** `start` returns `config.model.applied` false for a spawn-mode `claude-code` run
- **THEN** the skill's toolchain line has no model part and names the toolchains agents may run

### Requirement: Toolchain report: Codex line
For a `codex` run the toolchain line SHALL name the kind, the sandbox, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits").

#### Scenario: Codex line from the import skill
- **WHEN** the import skill calls `start` on a run whose `config.runnerKind` is `codex`
- **THEN** its toolchain line names `codex`, the model and effort, the sandbox, and the commit policy, with no allow-list part

### Requirement: Toolchain report: OpenCode line
For an `opencode` run the toolchain line SHALL name the kind, the permission, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits").

#### Scenario: OpenCode line from the work skill
- **WHEN** the work skill calls `start` on a run whose `config.runnerKind` is `opencode` with `permission` `allow` set in the file
- **THEN** its toolchain line names `opencode`, the model and effort, `permission allow`, and the commit policy, with no allow-list part

### Requirement: Toolchain report: resolving the check command
When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the `run`, `import`, and `work` skills SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously the skill SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms.

#### Scenario: Command from a package script
- **WHEN** `start` returns `needsConfig: ["checkCommand"]`, `CLAUDE.md` names no test command, and the root `package.json` has the script `test`
- **THEN** the skill calls `configure` with `checkCommand` `npm test` when that reading is unambiguous, or proposes it to the user, and reports where it found it

### Requirement: Toolchain report: check command never left unresolved
The `run`, `import`, and `work` skills SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user.

#### Scenario: Later digest names the command
- **WHEN** a `wait` digest names `checkCommand` under `needsConfig` while T1 is `submitted`
- **THEN** the skill resolves the check command or asks the user before waiting again, and does not call the run stalled

### Requirement: Toolchain report: access question offers
In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer a configuration change through `configure` for subsequent launches, SHALL say that the live agent cannot gain it, and SHALL offer to run the command on the agent's behalf and answer with the result.

#### Scenario: Run on the agent's behalf
- **WHEN** the user picks running the command for T2's `needsAccess` question
- **THEN** the skill runs the command in T2's worktree and sends the result with `answer`

### Requirement: Toolchain report: access change by kind
The configuration change the `run` skill offers for a `needsAccess` question SHALL be the one for the launch's kind: an `allowedTools` rule for `claude-code`, a wider `sandbox` for `codex`, and `permission: "allow"` for `opencode`, whose `derived` permission rejects a command outside the derived rules automatically.

#### Scenario: Codex access question
- **WHEN** a `needsAccess` question comes from a `codex` launch running under the `read-only` sandbox
- **THEN** the configuration change the skill offers is `configure` with `sandbox` `workspace-write`

### Requirement: Toolchain report: labels and keys documented
The `import` skill SHALL document the `runner:<kind>`, `model:<name>`, and `effort:<level>` labels as the way an issue chooses its worker kind, model, and effort, and SHALL report any `ignoredLabels` from the import summary to the user. The `import` skill's labels SHALL name the three kinds. The `run` skill SHALL document `runner.kind`, `runner.codex.*`, `runner.opencode.*`, and `budgets.prices`.

#### Scenario: Unrecognised label reported
- **WHEN** an import summary lists `ignoredLabels` for ENG-7's `effort:huge` label
- **THEN** the import skill tells the user that ENG-7's label was not recognised and the task will use the run default

### Requirement: OpenCode host: package
`hosts/opencode/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/opencode/node_modules` SHALL be ignored by git.

#### Scenario: Package pinned with the Claude Code plugin
- **WHEN** the host test reads `hosts/opencode/package.json`
- **THEN** it is private, its name differs from the published package's, its only dependency is the published package, and that dependency's version equals the one the Claude Code plugin pins

### Requirement: OpenCode host: registration snippet
`hosts/opencode/opencode.json` SHALL be the registration snippet. It SHALL declare `mcp.orchestrator_operator` with `type: "local"`, `command` set to `node`, the launcher, and `mcp`, and a per-server `timeout` in milliseconds above `WAIT_CAP_MS + 30000` (180000), because OpenCode cuts an MCP call at 60 seconds by default and the per-server `timeout` is the only cap opencode 1.18.30 honours. OpenCode names the tools `<id>_<tool>`, so they are `orchestrator_operator_<tool>`.

#### Scenario: Snippet registers the launcher
- **WHEN** the host test reads `hosts/opencode/opencode.json`
- **THEN** `mcp.orchestrator_operator` is `{ type: "local", command: ["node", "<hosts/opencode>/bin/orchestrator.mjs", "mcp"], timeout: 180000 }`, and the timeout is above `WAIT_CAP_MS + 30000`

### Requirement: OpenCode host: no mcp.timeout block
`hosts/opencode/opencode.json` SHALL have no `mcp.timeout` block, which 1.18.30 drops with a compatibility diagnostic.

#### Scenario: No global MCP timeout
- **WHEN** the host test reads `hosts/opencode/opencode.json`
- **THEN** it has no `mcp.timeout` key, and `orchestrator_operator` is the only key under `mcp`

### Requirement: OpenCode host: README install
`hosts/opencode/README.md` SHALL document merging the snippet into `~/.config/opencode/opencode.json` or a project's `opencode.json` as the primary install, and `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/opencode>/bin/orchestrator.mjs mcp` as the alternative, which cannot set `timeout`.

#### Scenario: Both installs documented
- **WHEN** `hosts/opencode/README.md` is read
- **THEN** it holds the snippet's `"orchestrator_operator"` entry with `"timeout": 180000` and the command `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=`

### Requirement: OpenCode host: README verification and pull mode
`hosts/opencode/README.md` SHALL document verification with `opencode mcp list`, the skills install, the plugin, the start-mode rule, and that the attachment ends when OpenCode closes the server's stdio. It SHALL have a pull-mode section documenting `orchestrator-work --runner opencode --workers 2`, run from a checkout as `node <hosts/codex>/bin/work.mjs --runner opencode`, and SHALL say that a `startupContended` start under `dataDir: shared` is released for relaunch.

#### Scenario: Pull-mode section
- **WHEN** `hosts/opencode/README.md` is read
- **THEN** it names `opencode mcp list` and `stdio`, documents `npx orchestrator-work --runner opencode --workers 2` and `node /path/to/orchestrator/hosts/codex/bin/work.mjs --runner opencode`, and says a `startupContended` start under `dataDir: shared` is released with `keep: true`

### Requirement: OpenCode host: skill editions
Each OpenCode skill SHALL be the Codex host's edition with the tool prefix `mcp__orchestrator_operator__` replaced by `orchestrator_operator_`, the host name changed, and only these blocks rewritten: the operator tools' permissions in place of Codex approvals (under `opencode run` a tool whose permission is `ask` is rejected automatically, and the remedy is `"orchestrator_operator_*": "allow"`), and the blocks of "OpenCode host: more rewritten skill blocks".

#### Scenario: No Codex tool prefix
- **WHEN** the host test reads each skill under `hosts/opencode/skills/`
- **THEN** none holds `mcp__orchestrator_operator__`, each holds `orchestrator_operator_`, and the run skill's permission block names `orchestrator_operator_*`

### Requirement: OpenCode host: more rewritten skill blocks
The blocks rewritten in each OpenCode skill SHALL also be the OpenCode form of the tracker connectors (`mcp.linear` and `mcp.atlassian` entries whose tools are `linear_<tool>` and `atlassian_<tool>`), the per-server `timeout` in place of `tool_timeout_sec`, the toolchain line and kind lists naming `opencode` (its permission and commit policy), and the pull-mode offer.

#### Scenario: Pull-mode offer rewritten
- **WHEN** the OpenCode run skill is compared with the Codex edition after the substitutions
- **THEN** the pull-mode offer naming `work.mjs --runner opencode --workers <n>` and the block naming the server's `timeout` in `opencode.json` are among the blocks that differ

### Requirement: OpenCode host: editions held by a host test
A host test SHALL hold the Codex and OpenCode editions of each skill to exactly the differences that "OpenCode host: skill editions" and "OpenCode host: more rewritten skill blocks" allow, and SHALL pin each rewritten block to its expected text (a hash of the block as the test normalises it), so a change anywhere in a rewritten block fails the test until the expectation is updated.

#### Scenario: A difference outside the rewritten blocks
- **WHEN** an OpenCode skill holds a block that differs from the Codex edition after the substitutions and holds none of the pinned phrases
- **THEN** the host test fails, naming the skill and quoting the start of the block

### Requirement: OpenCode host: start mode
Because an OpenCode session has no session workers, the skills SHALL call `start` with `mode: "spawn"` when no daemon is running and `orchestrator.yaml` sets no `runner.mode`, and without `mode` otherwise. When the mode in force is `pull` or `mixed` the OpenCode skills SHALL say so and SHALL offer `spawn` unless another session holds launches of the run.

#### Scenario: Runner mode set in the file
- **WHEN** no daemon is running and the repository's `orchestrator.yaml` sets `runner.mode`
- **THEN** the OpenCode run skill calls `start` without `mode` and respects the file

### Requirement: OpenCode host: work loop offer
When the run holds `opencode` launches the OpenCode skills SHALL also offer the work loop that `modeNote` names (`orchestrator-work --runner opencode`, "Work loop by runner kind"), started from a shell.

#### Scenario: Pull-mode run with opencode launches
- **WHEN** the mode in force is `pull` and the run holds `opencode` launches
- **THEN** the OpenCode run skill offers the work loop the `modeNote` names, started from a shell in the repository as `node <hosts/codex>/bin/work.mjs --runner opencode --workers <n> --run-tag <tag> --capacity <config.capacity>`

### Requirement: OpenCode host: session plugin
`hosts/opencode/plugins/orchestrator.js` SHALL be the session plugin, installed by linking it into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`). It SHALL export exactly one function, since OpenCode calls every exported function as a plugin. It SHALL find `hooks/session-start.mjs` beside its own real path, or under `ORCH_OPENCODE_HOST` for a copied install.

#### Scenario: One exported function
- **WHEN** the host test imports `hosts/opencode/plugins/orchestrator.js`
- **THEN** its only export is the function `OrchestratorPlugin`

### Requirement: OpenCode host: plugin appends the start line
On `session.created` for a session without a `parentID` the session plugin SHALL run `hooks/session-start.mjs` once with `node` and a ten-second timeout. On that session's first `chat.message` the session plugin SHALL append the line of `hooks/session-start.mjs` to the user's existing text part, SHALL never push a new part (OpenCode refuses a part without ids), and SHALL leave the message untouched when the script printed nothing.

#### Scenario: Subagent session skipped
- **WHEN** the plugin sees `session.created` for a session whose `parentID` is set, and then a `chat.message` for it, while a run needs attention
- **THEN** the message part is unchanged and no toast is shown

### Requirement: OpenCode host: plugin toast
The session plugin SHALL show the start line through `client.tui.showToast` and SHALL ignore a client without a TUI.

#### Scenario: Client without a TUI
- **WHEN** the plugin runs with a client whose `tui.showToast` throws, while a run needs attention
- **THEN** the first message's text part still ends with the start line and the plugin does not throw

### Requirement: OpenCode host: hook copies and pure launches
`hosts/opencode/hooks/` SHALL hold byte copies of the Claude Code plugin's `session-start.mjs` and `session-end.mjs`; nothing runs the end script, since OpenCode has no session end event and the operator server ends its own attachment when its stdio closes. Worker launches pass `--pure` by default, through the `{pure}` slot that `runner.opencode.pure` (default `true`) fills, and then never load the plugin.

#### Scenario: Default worker launch is pure
- **WHEN** an opencode worker launch is composed with the default settings
- **THEN** the command carries `--pure`

### Requirement: OpenCode host: worker launches that load the plugin
With `runner.opencode.pure: false` a worker launch omits `--pure` and loads the plugins of the project's `.opencode/plugins/` and, unless `runner.opencode.ignoreUserConfig` is `true`, the plugins installed under `~/.config/opencode/plugins/`, the session plugin included, so a worker started while a run needs attention gets the start line appended to its brief message. The session plugin SHALL NOT use `experimental.chat.system.transform`.

#### Scenario: No system transform
- **WHEN** `hosts/opencode/plugins/orchestrator.js` is read
- **THEN** it does not name `experimental.chat.system.transform`

### Requirement: OpenCode host: user config ignored
`runner.opencode.ignoreUserConfig: true` (default `false`) points `XDG_CONFIG_HOME` at an empty directory, so a plugin installed under `~/.config/opencode/plugins/` does not load. `hosts/opencode/README.md` SHALL say both what `runner.opencode.pure: false` does and what `runner.opencode.ignoreUserConfig: true` does.

#### Scenario: Empty config home
- **WHEN** an opencode launch is spawned with `ignoreUserConfig: true`
- **THEN** its `XDG_CONFIG_HOME` is `.orchestrator/opencode-config` in the worktree, an empty directory, while with the default `false` the runner does not set it

### Requirement: Codex plugin hooks: SessionEnd and the probed shape
`hosts/codex/hooks/hooks.json` SHALL run `hooks/session-end.mjs` (three-second timeout) on `SessionEnd` with `node` through `${PLUGIN_ROOT}`. This is the shape codex-cli 0.164 was probed running (test/fixtures/codex/plugin-probe): Codex reads the plugin's `hooks/hooks.json`, substitutes `${PLUGIN_ROOT}` with the installed plugin root before the shell runs, runs each hook as a child of the codex process, and adds the SessionStart hook's stdout to the session's context.

#### Scenario: SessionEnd hook declared
- **WHEN** the host tests read `hosts/codex/hooks/hooks.json`
- **THEN** `SessionEnd` holds one hook, with no matcher, whose command is `node "${PLUGIN_ROOT}/hooks/session-end.mjs"` and whose timeout is 3

### Requirement: Codex plugin hooks: timeouts and trust
A SessionEnd hook gets one second when it declares no timeout, and Codex caps a declared one at three seconds. Codex runs a plugin hook only when it is trusted, recorded in `config.toml` as `[hooks.state."<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<index>"]` with `trusted_hash` and `trusted_content_hash` by the interactive hook review, or under `--dangerously-bypass-hook-trust`. Under `codex exec` an untrusted hook is skipped without a message. The host README SHALL say so.

#### Scenario: README names the trust rule
- **WHEN** `hosts/codex/README.md` is read
- **THEN** it says Codex runs a plugin's hooks only once they are trusted, names `trusted_hash` and `trusted_content_hash`, and says that under `codex exec` untrusted hooks are skipped with no message unless `--dangerously-bypass-hook-trust` is passed

### Requirement: Codex plugin MCP server: timeouts and variables
`hosts/codex/.mcp.json` SHALL set `startup_timeout_sec: 60` (a first start may fetch through npx), `tool_timeout_sec` above `WAIT_CAP_MS / 1000 + 30` (180), and `env_vars` forwarding exactly `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, and `CODEX_API_KEY`, in that order. `ORCH_URL` lets the server reach a remote daemon. `CODEX_API_KEY` is the key variable `codex exec` reads. A host test SHALL pin the `env_vars` list.

#### Scenario: Timeouts pinned
- **WHEN** the host tests read `hosts/codex/.mcp.json`
- **THEN** `startup_timeout_sec` is 60 and `tool_timeout_sec` is above `WAIT_CAP_MS / 1000 + 30`

### Requirement: Codex plugin MCP server: environment
Codex gives a plugin's server only its `env_vars` and its own baseline (`HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`, and on macOS `__CF_USER_TEXT_ENCODING`), and the daemon the server starts inherits the server's environment and passes it to its codex workers. `CODEX_HOME` makes the workers of a spawn-mode daemon started from the plugin use the session's Codex home and its `auth.json`. `OPENAI_API_KEY` SHALL NOT be forwarded, because `codex exec` 0.164 ignores it.

#### Scenario: No OpenAI key forwarded
- **WHEN** the host tests read `env_vars` in `hosts/codex/.mcp.json`
- **THEN** it is exactly `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, `CODEX_API_KEY`, so `OPENAI_API_KEY` is not forwarded

### Requirement: Work loop silence limit from the daemon
When `--max-silence-ms` is not given and the claim carries a `health` field, the first limit SHALL be the claim's `health.stuckFailAfterMs` when positive, and after each `GET /v1/status` answer the limit SHALL be that answer's `budgets.stuckFailAfterMs` when it is a positive number; a value of 0 SHALL give 45 minutes, so a hung agent whose lease the loop renews is still bounded.

#### Scenario: Status raises the claimed limit
- **WHEN** the loop runs without `--max-silence-ms`, claims under `health.stuckFailAfterMs: 7000`, and `status` answers `budgets.stuckFailAfterMs: 60000`
- **THEN** the silence limit is 60000

#### Scenario: A claim of 0 follows status later
- **WHEN** the loop runs without `--max-silence-ms`, claims under `health.stuckFailAfterMs: 0`, and `status` later answers `budgets.stuckFailAfterMs: 9000`
- **THEN** the first limit is 45 minutes and then 9000

### Requirement: Work loop keeps its silence limit when status cannot be read
When `status` cannot be read (an answer that is not 200, a thrown request, or no number at `budgets.stuckFailAfterMs`) the loop SHALL keep the limit it had.

#### Scenario: Status without a number
- **WHEN** the loop runs without `--max-silence-ms` under a limit of 60000 and a `status` read throws, or answers `budgets.stuckFailAfterMs` as a string or a negative number
- **THEN** the silence limit stays 60000

### Requirement: Work loop renews while ending an agent
While the watcher is ending the agent's process group, the loop SHALL renew until the group is gone, so that it can release the launch itself.

#### Scenario: Renewal until the group is gone
- **WHEN** the watcher ends an agent that was silent past `--max-silence-ms` and the agent process exits before its process group closes
- **THEN** the loop keeps renewing until the group's output pipes close, then releases the launch itself without keep

### Requirement: Work loop renewal needs lease facts
A claim without lease facts SHALL start no renewal.

#### Scenario: Claim without a lease
- **WHEN** a claim carries neither `lease` nor `leaseTtlMs`
- **THEN** the loop starts no renewal and sends no `POST /v1/launches/:id/renew` for that launch

### Requirement: Run skill posts a milestone verdict as a project status update
For a project-milestone root the `run` skill SHALL post only a `comment` whose body opens with "Milestone accepted:" or "Milestone rejected:", as a project status update on the project the `url` names, with the body, a blank line and the marker as the last line, setting no health value (keeping the current health when the tool requires one), and SHALL acknowledge it with `result: { statusUpdateId }`.

#### Scenario: Tool that requires a health value
- **WHEN** the session's Linear tool requires a health value to post the accept comment of a project-milestone root
- **THEN** the skill posts the status update with the project's current health

### Requirement: Run skill posts a milestone verdict once
Before posting a project status update the `run` skill SHALL list the project's recent status updates and, if one holds the effect's marker, acknowledge with that update's id and not post again.

#### Scenario: No update holds the marker
- **WHEN** none of the project's recent status updates holds the marker of an accept comment for a project-milestone root
- **THEN** the skill posts one status update and acknowledges with its `statusUpdateId`

### Requirement: Run skill declines other project-root comments
Every other comment effect for a project-milestone root SHALL be acknowledged with `applied: false` and a reason.

#### Scenario: Blocked comment for a project root
- **WHEN** the outbox lists a blocked comment or a question for a root whose `url` holds `/project/`
- **THEN** the skill posts nothing and acknowledges it with `applied: false` and a reason

### Requirement: Run skill without a project status update tool
When the session has no tool that posts a project status update, the skill SHALL acknowledge the accept and reject comments with `applied: false` and a reason that says so, and tell the user once.

#### Scenario: No status update tool
- **WHEN** the session has no Linear tool that posts a project status update and the outbox lists the accept comment for a project-milestone root
- **THEN** the skill acknowledges it with `applied: false` and a reason that says so, and tells the user once

### Requirement: Run skill answers project-root effects with a result
The effects for a project-milestone root SHALL be answered with `result`, never with `error`, except that a tracker error while posting a status update is an error. An effect acknowledged with `applied: false` SHALL be counted in neither number of the tracker count line.

#### Scenario: Tracker error while posting
- **WHEN** posting the status update for an accept comment of a project-milestone root fails with a tracker error
- **THEN** the skill answers that effect with `error`, as for any effect

#### Scenario: Declined effect not counted
- **WHEN** the skill acknowledges a `setState` effect for a project-milestone root with `applied: false`
- **THEN** the effect is counted in neither number of the tracker count line

### Requirement: Work loop sleep gap
A *gap* SHALL be two consecutive notes more than `--gap-after-ms` apart (default 60000); a step exactly at the threshold, and a note earlier than the one before it, SHALL NOT be gaps. When the loop finds a gap it SHALL add the gap's length to the agent's last output time, capped at the present, and SHALL log one line with the length it left out, when that is above zero. The gap SHALL NOT be measured between two looks of the watcher.

#### Scenario: A step at the threshold
- **WHEN** two consecutive notes of the loop's clock are exactly `--gap-after-ms` apart, or a note is earlier than the one before it
- **THEN** no gap is found and nothing is left out of the silence

#### Scenario: Output right after a wake
- **WHEN** the agent writes output after a wake and before the next note, and that note finds a gap
- **THEN** the agent's last output time is capped at the note's time, so the silence is 0, not negative

### Requirement: Work loop sleep rule leaves the other rules alone
The loop SHALL NOT read the daemon's gap record, the silence limit SHALL be chosen as before, and the report grace SHALL keep counting wall time.

#### Scenario: Report grace counts a sleep
- **WHEN** a look of the watcher first finds the agent's launch reported, and the machine then sleeps for longer than the report grace
- **THEN** the sleep counts toward the report grace as wall time, and the loop ends the agent at its next look

### Requirement: Run skill raised limit: the configure offer
The bullet `- **a launch needs more time**` SHALL offer `configure` with `budgets: { maxLaunchMs }` for the time budget and with `health: { stuckFailAfterMs }` (`health.stuckFailAfterMs`) for a stuck launch that has a `pid`, say that values are milliseconds, tell the agent to check that `applied` lists `budgets` or `health`, to tell the worker the new limit with `nudge`, and to clear the override with a null leaf once the launch has reported or ended.

#### Scenario: A stuck launch with a pid
- **WHEN** the user wants a stuck launch that has a `pid` in `status.liveLaunches` to keep running
- **THEN** the bullet has the agent offer `configure` with `health: { stuckFailAfterMs: <ms> }` in milliseconds, check that `applied` lists `health`, and clear it with `health: { stuckFailAfterMs: null }` once the launch has reported or ended

### Requirement: Run skill raised limit: sentences by edition
The Claude Code edition SHALL say that a launch held by this session's workers has no `pid` and is bound by its lease, `leaseTtlMs`, a start-time key. The Codex and OpenCode editions SHALL hold the same bullet `- **a launch needs more time**` and SHALL say that a launch held by an `orchestrator-work` loop keeps the silence limit its loop took when it claimed.

#### Scenario: Claude Code edition names the lease
- **WHEN** the bullet `- **a launch needs more time**` is cut out of the Claude Code run skill
- **THEN** it says that a launch held by this session's workers has no `pid` and is bound by its lease, `leaseTtlMs`, a start-time key

### Requirement: Run skill lowering sentence in every edition
The Claude Code, Codex and OpenCode editions of the run skill SHALL hold the same sentence on a refused lowering, `wouldEnd` and `endLive`.

#### Scenario: Same sentence in three editions
- **WHEN** the sentence that starts "A lowered, cleared or switched-on limit" is cut out of the Claude Code, Codex and OpenCode run skills
- **THEN** the three are equal

### Requirement: Run skill: a work loop follows a changed limit
The Codex and OpenCode editions SHALL say that an `orchestrator-work` loop follows the new stuck limit from `status`, unless it was started with `--max-silence-ms`, which keeps that value, and SHALL NOT say that the loop keeps the limit of its claim. The Codex and OpenCode bullets **a launch needs more time** SHALL stay identical after the tool-name substitution.

#### Scenario: Codex and OpenCode bullets equal
- **WHEN** the bullet **a launch needs more time** is cut out of the Codex and OpenCode run skills and the tool-name substitution is applied to the Codex one
- **THEN** the two are identical and hold `orchestrator-work` and `--max-silence-ms`

### Requirement: Run skill Worker profile paragraph: before a graph
The **Worker profile.** paragraph of each run skill SHALL say that the `start` result's `confirmProfile` tells whether the profile hold is on; that before a graph is loaded, with `confirmProfile` true and `config.model.source` or `config.effort.source` `default`, the session asks the user for the model and effort, naming the value shown as one option.

#### Scenario: Default profile before a graph
- **WHEN** the session starts a run with no graph loaded, `confirmProfile` true and `config.model.source` `default`
- **THEN** the paragraph has it ask the user now which model and effort the workers run with, naming the value shown as one option

### Requirement: Run skill Worker profile paragraph: with a graph
The **Worker profile.** paragraph of each run skill SHALL say that with a graph the session reads `status.profiles` (again after every import), tells the user every entry with its sources (`modelSource`, `effortSource`) and asks for the keys in `missing` of every entry with `held: true`; that the answer is applied with `configure` (`model` and `effort` for the kind in force, or the `claude`, `codex` or `opencode` object), also when the user accepts the value shown.

#### Scenario: The user accepts the value shown
- **WHEN** an entry of `status.profiles` has `held: true` and the user accepts the value the session named
- **THEN** the session still applies it with `configure`, so that its source becomes `argument`

### Requirement: Run skill Worker profile paragraph: the user chooses
The **Worker profile.** paragraph of each run skill SHALL say that the session never chooses from the model of this session nor without the user's answer; and that `orchestrator.yaml` holds a lasting choice and `runner.confirmProfile: false` there turns the hold off.

#### Scenario: Lasting choice
- **WHEN** the **Worker profile.** paragraph of a run skill is read
- **THEN** it says never to choose the profile from the model of this session nor without the user's answer, and names `runner.claude`, `runner.codex` or `runner.opencode` in `orchestrator.yaml` and `runner.confirmProfile: false`

### Requirement: Run skill profileHeld bullet
Each monitor list SHALL hold one bullet that starts with `- **profileHeld**`, directly after the `needsConfig` bullet, that sends the session to the **Worker profile.** paragraph and says the run is not slow or stalled.

#### Scenario: Bullet after needsConfig
- **WHEN** the monitor list of each run skill is read
- **THEN** the bullet that starts `- **profileHeld**` directly follows the `needsConfig` bullet, sends the session to the Worker profile paragraph, and says not to call the run slow or stalled

### Requirement: Work skill Worker profile bullet
The Claude Code work skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**` and says to follow the run skill's paragraph before running workers when `status.profiles` has an entry with `held: true`.

#### Scenario: Held tasks before workers run
- **WHEN** `status.profiles` has an entry with `held: true` when the Claude Code work skill is followed
- **THEN** the skill has the session follow the run skill's Worker profile paragraph before running workers, since held tasks are never claimable

### Requirement: Import skill Worker profile bullet
Each import skill SHALL hold one bullet in section 1 that starts with `- **Worker profile.**`, directly after the bullet that starts "The orchestrator daemon must be running for this repository".

#### Scenario: Bullet placement
- **WHEN** section 1 of each import skill is read
- **THEN** the bullet that starts `- **Worker profile.**` directly follows the bullet that starts "The orchestrator daemon must be running for this repository"

### Requirement: Import skill asks for the profile before the import
The `- **Worker profile.**` bullet of each import skill SHALL say that when the `start` result has `confirmProfile` true and `config.model.source` or `config.effort.source` is `default`, the imported tasks will be held, so the session asks the user for the model and effort before the import and applies the answer with `configure`, as the run skill's Worker profile paragraph says.

#### Scenario: Default profile at import
- **WHEN** the `start` result has `confirmProfile` true and `config.effort.source` `default` before an import
- **THEN** the session asks the user for the model and effort before the import, naming the value shown as one option, and applies the answer with `configure`

### Requirement: Codex README shows what Codex can show of workers
`hosts/codex/README.md` SHALL have a section "Workers in a Codex session" that names the codex version it was checked with and gives, each with the command that shows it: whether a `codex exec` session kept without `--ephemeral` is listed by `codex resume` and where its file is, whether a session can be named or is found by its cwd, whether `codex agents` lists exec sessions, and whether a session or a plugin's skill can start subagents and the TUI shows them.

#### Scenario: The section names its facts and commands
- **WHEN** the host tests read the README from `## Workers in a Codex session` up to `## Approvals`
- **THEN** it names `codex-cli 0.170.0`, `codex resume --include-non-interactive`, `codex agents`, `thread_spawn_edges`, `spawn_agent`, `agents.enabled=false`, `multi_agent_v2`, the plugin probe `codex plugin add pingplug@probe-market`, the TUI line "Started `/root/pingworker`", and `codex exec resume <thread_id>`

### Requirement: Run skill says where a Codex worker's session is
The Codex `orchestrator-run` skill, in its pull-mode part, SHALL tell the user that `runner.codex.ephemeral: false` keeps each worker's session, listed by `codex resume --include-non-interactive` and `codex agents`, and how to find a launch's session: from its worktree, or by the thread id `orchestrator-work` prints, with `codex exec resume <thread_id>`. The default of `runner.codex.ephemeral` SHALL stay `true`. The skill SHALL NOT state that a Codex session has no subagents.

#### Scenario: The user asks where a worker went
- **WHEN** a pull-mode codex run is worked by `orchestrator-work` and the user asks why its workers are not shown in their Codex session
- **THEN** the skill says each worker is a `codex exec` outside the session, that the default `runner.codex.ephemeral: true` keeps no session, that setting it to `false` in `orchestrator.yaml` before `start` keeps one, and that a launch's session is found with `codex resume --include-non-interactive` in its worktree (or `--all`) or with `codex exec resume <thread_id>`

#### Scenario: Subagents are not denied
- **WHEN** the host tests read the Codex run skill
- **THEN** it does not say that the session has no subagents, and says that a Codex session can start subagents but no orchestrator work loop uses them yet, naming the README section

### Requirement: Work loop names each codex session
For a codex launch, `orchestrator-work` SHALL print one stderr line per launch, once the agent's output holds its first `thread.started` event, naming that event's `thread_id` and whether the session is kept: `kept: codex exec resume <thread_id>` when the claim's `codex.settings.ephemeral` is `false`, else `ephemeral: not kept`. An opencode launch SHALL print no such line.

#### Scenario: Three launches name their sessions
- **WHEN** two codex loops drain a three-task pull-mode graph with the default settings
- **THEN** their stderr holds three lines `cx-<n>: T<k> codex session <thread_id> (ephemeral: not kept)`, one per launch

#### Scenario: A kept session names the resume command
- **WHEN** the codex adapter reads output whose first event is `{"type":"thread.started","thread_id":"<id>"}` and the claim's settings have `ephemeral: false`
- **THEN** the line is `codex session <id> (kept: codex exec resume <id>)`
