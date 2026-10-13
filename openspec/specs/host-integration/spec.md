# Host Integration Specification

## Purpose
How the orchestrator is packaged for host sessions: the npm package's subpath exports and executables, thin per-host wrappers under `hosts/<host>/` such as the Claude Code plugin, the import, run, and review skills those wrappers ship, including how the import skill records the tracker and how the run skill mirrors the run back to it by draining the outbox, handles stuck tasks and budget pauses on the user's say, presents pending proposals for the user to accept or reject, creating the tracker issue first in a tracker-backed run, and offers `cascade` with its plan when a reopen is refused for its blockers, the `work` skill and the bundled `workflows/work.js` workflow through which a session fans out worker subagents that claim and work prepared launches in `pull` or `mixed` mode, and the marketplace manifest at the repository root through which the plugin is installed.

## Requirements

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

### Requirement: Import skill records the tracker
The `import` skill SHALL pass `tracker` to `import_issues`, with `kind` `linear` or `atlassian` according to the connector it fetched from and `workspace` naming the Linear workspace or the Jira site when the connector reports it.

#### Scenario: Linear import names its tracker
- **WHEN** the import skill fetches an epic through the Linear tools
- **THEN** its `import_issues` call carries `tracker.kind` `linear`

### Requirement: Run skill mirrors to the tracker
After every `wait` return, before acting on the digest, the `run` skill SHALL drain the outbox: call `outbox`; apply each effect in `id` order with the session's tracker tools; and for each effect either `ack` with the vendor result or `ack` with the error. It SHALL map `setState` by state type, never by name: for Linear the workflow state of type `started`, `completed`, or `canceled`; for Jira a transition to a status in the category In Progress or Done, and to a canceled-type status when the workflow has one. When the tracker has no canceled-type state the skill SHALL leave the state and post a comment saying the task was cancelled. Before posting a `comment` it SHALL list the issue's recent comments and, if one carries the effect's marker, SHALL `ack` with that comment's id instead of posting; otherwise it SHALL post the body with the marker as the last line and `ack` with the new comment's id. After an error on one issue it SHALL leave that issue's later effects for the next drain. When the policy's `answersFromComments` is true, the skill SHALL then, for every task in `openQuestions`, read the issue's comments, ignore any carrying the orchestrator marker, and relay through `answer` the first human comment posted after the latest marked comment that it has not relayed before, remembering what it relayed. An `answer` the daemon refuses with 409 because the task is no longer `waiting` or `blocked` SHALL be reported to the user and not retried. The skill SHALL keep effect payloads out of the conversation except for a one-line count of what it applied.

#### Scenario: Drain after wait
- **WHEN** `wait` returns and `outbox` lists a `setState inProgress` for ENG-12 and a `comment` for ENG-13
- **THEN** the skill sets ENG-12 to the started-type state, posts the comment with its marker on ENG-13, and acknowledges both with the vendor ids before calling `wait` again

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
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable. The workflow SHALL fan out one loop per worker with `parallel`; each cycle SHALL claim with the loop's worker id, wait briefly and retry when nothing is claimable, and otherwise run a worker agent whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. A loop SHALL end when nothing is claimable, no loop holds a launch, and the digest reports finished, stalled, or an open question. Workflow results SHALL be short outcomes, never briefs or logs.

#### Scenario: Two workers drain a graph
- **WHEN** the work skill runs with two workers on a three-task graph in `pull` mode
- **THEN** every task is claimed, worked, and submitted by a worker, the integration branch gains one trailer commit per task, and the workflow returns when the run is finished

#### Scenario: Question ends the loop and a re-run resumes it
- **WHEN** a worker asks a question nobody answers and nothing else is claimable
- **THEN** the workflow returns with the question in the digest, the skill answers it through the user, and the re-run worker with the same id receives the answer through `launch_block`

### Requirement: Marketplace manifest
The repository SHALL contain `.claude-plugin/marketplace.json` at its root listing the `orchestrator` plugin with `source: "./hosts/claude-code"`, so that `claude plugin marketplace add <owner>/orchestrator` installs the plugin. The plugin manifest version SHALL equal the package version, and a test SHALL assert it. The plugin SHALL still pass `claude plugin validate --strict` with the work skill and workflow present.

#### Scenario: Versions match
- **WHEN** the host tests run
- **THEN** `hosts/claude-code/.claude-plugin/plugin.json` and `package.json` report the same version, and the marketplace manifest names the plugin with that source

#### Scenario: Plugin validates with the additions
- **WHEN** `claude plugin validate --strict hosts/claude-code` is run after the skill and workflow are added
- **THEN** it reports validation passed

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
