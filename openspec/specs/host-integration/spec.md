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

### Requirement: Import skill records the tracker
The `import` skill SHALL pass `tracker` to `import_issues`, with `kind` `linear`, `atlassian`, or `github` according to the connector it fetched from and `workspace` naming the Linear workspace, the Jira site, or the GitHub repository as `owner/repo`. For GitHub it SHALL build records as follows: the root is an issue named by number or URL, or a milestone; children are the root's sub-issues, or the milestone's issues; `blockedBy` comes from the issue's `blockedBy` dependencies, with every blocker outside the child set fetched for its state; ids are `GH-<number>` for issues in the tracker's repository and `GH-<owner>-<repo>-<number>` otherwise, a milestone root is `GH-M<number>`, and every record carries its `url`; `state` is `open` for an open issue, `inProgress` for an open issue carrying `inProgressLabel` when one is configured, `done` for a closed issue with reason `COMPLETED`, and `cancelled` for `NOT_PLANNED` or `DUPLICATE`; `priority` is the number from a `P0`..`P4` or `priority:<n>` label and is otherwise omitted; `labels` and `description` pass through. When a repository has a label that looks like an in-progress marker and none is configured, the skill SHALL offer it. When the root has no sub-issues or milestone issues the skill SHALL say so and SHALL NOT import an empty epic. A re-import after the run has published tasks SHALL send the tracker's current states as they are: the daemon accepts a published task becoming a done external, and a task the tracker shows reopened is not reopened by import but by `reopen`.

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
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable. The skill SHALL say that pull-mode workers are this session's Claude subagents, which claim only `claude-code` launches, so that codex launches are worked only in `spawn` or `mixed`; when only codex launches are parked it SHALL offer `start` with `mode: "spawn"` or `"mixed"` instead of running the workflow. The workflow SHALL claim with `runner: "claude-code"`, so that codex-kind launches are never claimed by the Claude worker loop, and its stop rule SHALL count only `claimableByKind["claude-code"]`. The workflow SHALL clamp the worker count to the `capacity` argument when one is given, logging the clamp, and SHALL fan out one loop per worker with `parallel`. Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, read `status`, evaluate the stop rule, and claim again, up to three polls before returning without a launch. On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. A loop SHALL end when nothing is claimable, no loop holds a launch, and the digest reports finished, stalled, or an open question. Workflow results SHALL be short outcomes, never briefs or logs. The `work` and `run` skills SHALL document `claimModel` and `claimEffort` with their defaults and pass them only when the user asks for a different claimer, and SHALL say that workers edit worktrees under the run directory, outside the repository, so a session in `acceptEdits` mode prompts for each file there unless started with `--add-dir` for that directory.

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

### Requirement: Skills report the toolchain
After `start` returns, the `run`, `import`, and `work` skills SHALL report the resolved toolchain to the user in one line. The line SHALL name the check command, the integration branch, the worker kind with its model and effort (`config.runnerKind`, `config.model`, `config.effort`), and the source of each. The default named SHALL be the one of the kind in force: `claude-opus-5-5` at `medium` for `claude-code`, `gpt-6-astra` at `medium` for `codex`, `anthropic/claude-opus-5-5` at `medium` for `opencode`. For a `claude-code` run whose daemon spawns agents, the line SHALL also name the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node"). For a `codex` run the line SHALL name the kind, the sandbox, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits"). For an `opencode` run the line SHALL name the kind, the permission, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers opencode anthropic/claude-opus-5-5 at medium (default); permission derived, agent commits"). When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the skill SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously it SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms. It SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user. In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer a configuration change through `configure` for subsequent launches, SHALL say that the live agent cannot gain it, and SHALL offer to run the command on the agent's behalf and answer with the result. The change SHALL be the one for the launch's kind: an `allowedTools` rule for `claude-code`, a wider `sandbox` for `codex`, and `permission: "allow"` for `opencode`, whose `derived` permission rejects a command outside the derived rules automatically. The `import` skill SHALL document the `runner:<kind>`, `model:<name>`, and `effort:<level>` labels as the way an issue chooses its worker kind, model, and effort, and SHALL report any `ignoredLabels` from the import summary to the user. The `import` skill's labels SHALL name the three kinds. The `run` skill SHALL document `runner.kind`, `runner.codex.*`, `runner.opencode.*`, and `budgets.prices`. When launches are worked by session subagents the allow-list part of the report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted.

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
- A loop SHALL stop when the run is finished or stalled; or when nothing is claimable for its kind (`claimableByKind.<kind>` is 0), no launch of that kind is live, no task is awaiting the verifier (`status.verifying` is empty), and a question or review waits on a human; or when that quiet has lasted `--idle-exit-ms`. A review is a node in `awaitingReview` that is not in `verifying`; a submitted task awaiting its check waits on no human, and its result can make a dependent claimable or send the task back for another launch. The log line SHALL name the kind. It SHALL also stop after `--max-failures` launches in a row that ended without the agent running or reporting; a contended start counts, and so does an agent the loop ended as hung.
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

### Requirement: OpenCode host
`hosts/opencode/` SHALL let an OpenCode session be the operator. It SHALL ship `bin/orchestrator.mjs`, the third copy of the launcher of "Plugin launcher", whose npx fallback is pinned to the version of the published package in `hosts/opencode/package.json`. `hosts/opencode/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/opencode/node_modules` SHALL be ignored by git.

`hosts/opencode/opencode.json` SHALL be the registration snippet. It SHALL declare `mcp.orchestrator_operator` with `type: "local"`, `command` set to `node`, the launcher, and `mcp`, and a per-server `timeout` in milliseconds above `WAIT_CAP_MS + 30000` (180000), because OpenCode cuts an MCP call at 60 seconds by default and the per-server `timeout` is the only cap opencode 1.18.30 honours. It SHALL have no `mcp.timeout` block, which 1.18.30 drops with a compatibility diagnostic. OpenCode names the tools `<id>_<tool>`, so they are `orchestrator_operator_<tool>`.

`hosts/opencode/README.md` SHALL document merging the snippet into `~/.config/opencode/opencode.json` or a project's `opencode.json` as the primary install, and `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/opencode>/bin/orchestrator.mjs mcp` as the alternative, which cannot set `timeout`. It SHALL document verification with `opencode mcp list`, the skills install, the plugin, the start-mode rule, and that the attachment ends when OpenCode closes the server's stdio. It SHALL have a pull-mode section documenting `orchestrator-work --runner opencode --workers 2`, run from a checkout as `node <hosts/codex>/bin/work.mjs --runner opencode`, and SHALL say that a `startupContended` start under `dataDir: shared` is released for relaunch.

`hosts/opencode/skills/` SHALL hold `import`, `run`, and `review` skills named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`. Each SHALL be the Codex host's edition with the tool prefix `mcp__orchestrator_operator__` replaced by `orchestrator_operator_`, the host name changed, and only these blocks rewritten: the operator tools' permissions in place of Codex approvals (under `opencode run` a tool whose permission is `ask` is rejected automatically, and the remedy is `"orchestrator_operator_*": "allow"`), the OpenCode form of the tracker connectors (`mcp.linear` and `mcp.atlassian` entries whose tools are `linear_<tool>` and `atlassian_<tool>`), the per-server `timeout` in place of `tool_timeout_sec`, the toolchain line and kind lists naming `opencode` (its permission and commit policy), and the pull-mode offer. A host test SHALL hold the two editions to exactly those differences, and SHALL pin each rewritten block to its expected text (a hash of the block as the test normalises it), so a change anywhere in a rewritten block fails the test until the expectation is updated. Because an OpenCode session has no session workers, the skills SHALL call `start` with `mode: "spawn"` when no daemon is running and `orchestrator.yaml` sets no `runner.mode`, and without `mode` otherwise. When the mode in force is `pull` or `mixed` they SHALL say so and SHALL offer `spawn` unless another session holds launches of the run. When the run holds `opencode` launches they SHALL also offer the work loop that `modeNote` names (`orchestrator-work --runner opencode`, "Work loop by runner kind"), started from a shell.

`hosts/opencode/plugins/orchestrator.js` SHALL be the session plugin, installed by linking it into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`). It SHALL export exactly one function, since OpenCode calls every exported function as a plugin. It SHALL find `hooks/session-start.mjs` beside its own real path, or under `ORCH_OPENCODE_HOST` for a copied install. On `session.created` for a session without a `parentID` it SHALL run the script once with `node` and a ten-second timeout. On that session's first `chat.message` it SHALL append the script's line to the user's existing text part, SHALL never push a new part (OpenCode refuses a part without ids), and SHALL leave the message untouched when the script printed nothing. It SHALL show the line through `client.tui.showToast` and SHALL ignore a client without a TUI. It SHALL NOT use `experimental.chat.system.transform`. `hosts/opencode/hooks/` SHALL hold byte copies of the Claude Code plugin's `session-start.mjs` and `session-end.mjs`; nothing runs the end script, since OpenCode has no session end event and the operator server ends its own attachment when its stdio closes. Worker launches pass `--pure` by default, through the `{pure}` slot that `runner.opencode.pure` (default `true`) fills, and then never load the plugin. With `runner.opencode.pure: false` a worker launch omits `--pure` and loads the plugins of the project's `.opencode/plugins/` and, unless `runner.opencode.ignoreUserConfig` is `true`, the plugins installed under `~/.config/opencode/plugins/`, this one included, so a worker started while a run needs attention gets the start line appended to its brief message. `runner.opencode.ignoreUserConfig: true` (default `false`) points `XDG_CONFIG_HOME` at an empty directory, so a plugin installed under `~/.config/opencode/plugins/` does not load. `hosts/opencode/README.md` SHALL say both.

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

### Requirement: Work loop ends a hung agent
While an agent runs, the work loop SHALL read its launch from `GET /v1/status` every `--poll-ms` and SHALL end the agent's process group (SIGTERM, then SIGKILL after 5 s), logging the reason, when the daemon has ended the launch; when its task reported 30 s ago and the agent has not exited; or when its task is running and the agent has written nothing for longer than the silence limit. Silence SHALL NOT be counted while the task waits on an answer.

#### Scenario: Ended launch
- **WHEN** the worker no longer holds the launch and its task is neither submitted nor done (failed, stuck, lease expired, cancelled, released, or relaunched on another launch)
- **THEN** the loop ends the agent's process group, sending SIGKILL after 5 s even when the shell has already exited

#### Scenario: Daemon unreachable
- **WHEN** `GET /v1/status` fails while the agent runs
- **THEN** only the silence limit applies

#### Scenario: The daemon expires a silent claim
- **WHEN** the claimed agent never writes and never exits, and the daemon fails the launch `leaseExpired` (or `stuck`) and relaunches the task
- **THEN** the loop logs that the daemon ended the launch, ends the agent's process group, and claims the relaunch

#### Scenario: An agent that reported keeps its last output
- **WHEN** the agent submits and the daemon ends the launch `reported` while the agent is still printing its final events
- **THEN** the loop does not end it for 30 s, so its usage is posted with `usageSource: "worker"`

#### Scenario: Waiting is not silence
- **WHEN** the agent is blocked on a question for longer than the silence limit
- **THEN** the loop does not end it

### Requirement: Work loop silence limit
The work loop's silence limit SHALL be `--max-silence-ms` when given, else the claim's `health.stuckFailAfterMs` when the claim carries a positive one, else 45 minutes (the daemon's default `health.stuckFailAfterMs`). `--max-silence-ms 0` SHALL turn it off.

#### Scenario: The claim names no threshold
- **WHEN** the loop runs without `--max-silence-ms` against a daemon whose claim carries no `health`
- **THEN** the silence limit is 45 minutes

#### Scenario: Silence past the limit
- **WHEN** the loop runs with `--max-silence-ms 5000` and the claimed agent writes nothing for longer while its task runs and the launch is still held
- **THEN** the loop ends the agent's process group, releases the launch with `keep: false` and a reason naming the silence, and claims the next launch

### Requirement: Work loop after ending an agent
After an agent the loop ended has exited, the loop SHALL post its usage as for any exit and SHALL NOT classify its output as a start failure. It SHALL release the launch without keep, with a reason naming the termination, when the worker still holds it, and SHALL NOT release a launch the daemon ended. The outcome SHALL be `hung`, counted toward `--max-failures`, except after a report, when it SHALL be `started`. The loop SHALL then claim again.

#### Scenario: The daemon's verdict stands
- **WHEN** the loop ends an agent whose launch the daemon failed `leaseExpired`
- **THEN** no `operator.release` is recorded for that launch and the outcome is `hung`

#### Scenario: A model that always hangs
- **WHEN** `--max-failures` launches in a row end with the outcome `hung`
- **THEN** the loop stops
