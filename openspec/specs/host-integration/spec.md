# Host Integration Specification

## Purpose
How the orchestrator is packaged for host sessions: the npm package's subpath exports and executables, thin per-host wrappers under `hosts/<host>/` such as the Claude Code plugin, and the import, run, and review skills those wrappers ship, including how the import skill records the tracker and how the run skill mirrors the run back to it by draining the outbox, handles stuck tasks and budget pauses on the user's say, presents pending proposals for the user to accept or reject, creating the tracker issue first in a tracker-backed run, and offers `cascade` with its plan when a reopen is refused for its blockers.

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
