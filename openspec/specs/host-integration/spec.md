# Host Integration Specification

## Purpose
How the orchestrator is packaged for host sessions: the npm package's subpath exports and executables, thin per-host wrappers under `hosts/<host>/` such as the Claude Code plugin, the import, run, and review skills those wrappers ship, including how the import skill records the tracker and how the run skill mirrors the run back to it by draining the outbox, handles stuck tasks and budget pauses on the user's say, presents pending proposals for the user to accept or reject, creating the tracker issue first in a tracker-backed run, and offers `cascade` with its plan when a reopen is refused for its blockers, the `work` skill and the bundled `workflows/work.js` workflow through which a session fans out worker subagents that claim and work prepared launches in `pull` or `mixed` mode, and the marketplace manifest at the repository root through which the plugin is installed.

## Requirements

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
The plugin SHALL provide four skills. `import` SHALL require a tracker connector: a Linear or Atlassian MCP server, or GitHub through a `gh` CLI whose `gh auth status` succeeds or a GitHub MCP server; it SHALL refuse with a clear message naming the three options otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria. `run` SHALL call `start`, and when the mode in force is `pull` or `mixed` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag, then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report; it SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative. `review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note. `work` SHALL remain the explicit way to add workers from a session or to switch the mode. No skill SHALL instruct the user to put the package on PATH. Skills SHALL keep digests, not raw events, in the conversation.

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

### Requirement: Import skill records the tracker
The `import` skill SHALL pass `tracker` to `import_issues`, with `kind` `linear`, `atlassian`, or `github` according to the connector it fetched from and `workspace` naming the Linear workspace, the Jira site, or the GitHub repository as `owner/repo`. For GitHub it SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state; ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`; `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through. When a repository has a label that looks like an in-progress marker and none is configured, the skill SHALL offer it. When the root has no sub-issues or milestone issues the skill SHALL say so and SHALL NOT import an empty epic.

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
After every `wait` return, before acting on the digest, the `run` skill SHALL drain the outbox: call `outbox`; apply each effect in `id` order with the session's tracker tools; and for each effect either `ack` with the vendor result or `ack` with the error. It SHALL map `setState` by state type, never by name: for Linear the workflow state of type `started`, `completed`, or `canceled`; for Jira a transition to a status in the category In Progress or Done, and to a canceled-type status when the workflow has one; for GitHub, acting on the effect's `url`, `done` closes the issue with reason `completed`, `cancelled` closes it with reason `not planned`, both removing the policy's `inProgressLabel` when the issue carries it, and `inProgress` reopens the issue when it is closed and adds the label, or is acknowledged as skipped when no label is configured. When the tracker has no canceled-type state the skill SHALL leave the state and post a comment saying the task was cancelled. For a GitHub milestone root, `done` SHALL close the milestone and `comment` effects SHALL be acknowledged as skipped. Before posting a `comment` it SHALL list the issue's recent comments and, if one carries the effect's marker, SHALL `ack` with that comment's id instead of posting; otherwise it SHALL post the body with the marker as the last line and `ack` with the new comment's id. After an error on one issue it SHALL leave that issue's later effects for the next drain. When the policy's `answersFromComments` is true, the skill SHALL then, for every task in `openQuestions`, read the issue's comments, ignore any carrying the orchestrator marker, and relay through `answer` the first human comment posted after the latest marked comment that it has not relayed before, remembering what it relayed. An `answer` the daemon refuses with 409 because the task is no longer `waiting` or `blocked` SHALL be reported to the user and not retried. On accepting a proposal in a GitHub run the skill SHALL create the issue as a sub-issue of the root, add a dependency on the proposing task's issue, and pass `GH-<number>` as `nodeId`. The skill SHALL keep effect payloads out of the conversation except for a one-line count of what it applied.

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
When the digest's `proposals` is non-empty the run skill SHALL present each pending proposal to the user with its title, description, acceptance criteria, and deps, and SHALL wait for a decision. On acceptance in a run imported from a tracker, the skill SHALL create the issue through the session's tracker tools as a child of the epic, blocked by the proposing task's issue, with a description that carries the acceptance criteria under the configured heading, and SHALL call `accept_proposal` with the new issue's identifier as `nodeId`. In a file-based run it SHALL call `accept_proposal` without `nodeId`. On rejection it SHALL call `reject_proposal` with the user's note. The skill SHALL never accept a proposal without the user. When the user asks to reopen a task and `reopen` returns `blockers`, the skill SHALL show the blockers, offer `cascade`, and show the returned plan.

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
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable. The workflow SHALL clamp the worker count to the `capacity` argument when one is given, logging the clamp, and SHALL fan out one loop per worker with `parallel`. Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, read `status`, evaluate the stop rule, and claim again, up to three polls before returning without a launch. On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. A loop SHALL end when nothing is claimable, no loop holds a launch, and the digest reports finished, stalled, or an open question. Workflow results SHALL be short outcomes, never briefs or logs. The `work` and `run` skills SHALL document `claimModel` and `claimEffort` with their defaults and pass them only when the user asks for a different claimer, and SHALL say that workers edit worktrees under the run directory, outside the repository, so a session in `acceptEdits` mode prompts for each file there unless started with `--add-dir` for that directory.

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

### Requirement: No native dependencies
The npm package SHALL depend only on pure-JavaScript packages: no production dependency, direct or transitive, optional dependencies included, SHALL carry an `install`, `preinstall`, or `postinstall` script or a `binding.gyp`, so that an install with `--ignore-scripts`, such as a Claude Code plugin's automatic dependency install, yields a working package. The store SHALL use Node's built-in `node:sqlite` binding, and `engines.node` SHALL be `>=22.13.0`, the first release that loads `node:sqlite` without a flag. A host test SHALL assert the property from `package-lock.json` and the installed tree.

#### Scenario: Lockfile has no native module
- **WHEN** the host tests read `package-lock.json` and `node_modules`
- **THEN** no entry other than a dev-only one carries `hasInstallScript`, no production package directory contains `binding.gyp`, and `better-sqlite3` is in neither `dependencies` nor `devDependencies`

#### Scenario: Node floor declared
- **WHEN** the host tests read `package.json`
- **THEN** `engines.node` is `>=22.13.0`

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

### Requirement: Skills report the toolchain
After `start` returns, the `run`, `import`, and `work` skills SHALL report the resolved toolchain to the user in one line naming the check command, the integration branch, the worker model and effort, the source of each, and, for a run whose daemon spawns agents, the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node"). When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the skill SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously it SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms. It SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user. In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer to add a rule through `configure` for subsequent launches, SHALL say that the live agent cannot gain the rule, and SHALL offer to run the command on the agent's behalf and answer with the result. The `import` skill SHALL document the `model:<name>` and `effort:<level>` labels as the way an issue chooses its worker model and effort, and SHALL report any `ignoredLabels` from the import summary to the user. When launches are worked by session subagents the allow-list part of the report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted.

#### Scenario: Detected toolchain reported
- **WHEN** the run skill calls `start` in a Node repository and the result shows `checkCommand` detected as `npm test` on `main` with the default model and effort
- **THEN** the skill tells the user "detected: npm test on main; workers claude-opus-5-5 at medium" with the sources before looping on `wait`

#### Scenario: Unresolved command found in CLAUDE.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and `CLAUDE.md` says "run tests with `make check`"
- **THEN** the skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `CLAUDE.md`

#### Scenario: Unresolved command with nothing documented
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and neither `CLAUDE.md`, the README, nor a manifest names a test command
- **THEN** the skill asks the user for the command and calls `configure` only with what the user gives

#### Scenario: Access question answered without a restart
- **WHEN** `wait` returns a `needsAccess` question from T2 asking to run `docker compose up`
- **THEN** the skill offers to add `Bash(docker:*)` for later launches, says T2's live agent cannot gain it, and offers to run the command and answer T2 with the result

#### Scenario: Ignored label reported at import
- **WHEN** the import summary lists `ignoredLabels: [{ id: "KNO-7", label: "effort:huge" }]`
- **THEN** the import skill tells the user that KNO-7's `effort:huge` label was not recognised and the task will use the run default
