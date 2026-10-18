## MODIFIED Requirements

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
After every `wait` return, before acting on the digest, the `run` skill SHALL drain the outbox: call `outbox`; apply each effect in `id` order with the session's tracker tools; and for each effect either `ack` with the vendor result or `ack` with the error. It SHALL map `setState` by state type, never by name: for Linear the workflow state of type `started`, `completed`, or `canceled`; for Jira a transition to a status in the category In Progress or Done, and to a canceled-type status when the workflow has one; for GitHub, acting on the effect's `url`, `done` closes the issue with reason `completed`, `cancelled` closes it with reason `not planned`, and `inProgress` reopens the issue when it is closed and adds the policy's `inProgressLabel`, or is acknowledged as skipped when no label is configured. When the tracker has no canceled-type state the skill SHALL leave the state and post a comment saying the task was cancelled. For a GitHub milestone root, `done` SHALL close the milestone and `comment` effects SHALL be acknowledged as skipped. Before posting a `comment` it SHALL list the issue's recent comments and, if one carries the effect's marker, SHALL `ack` with that comment's id instead of posting; otherwise it SHALL post the body with the marker as the last line and `ack` with the new comment's id. After an error on one issue it SHALL leave that issue's later effects for the next drain. When the policy's `answersFromComments` is true, the skill SHALL then, for every task in `openQuestions`, read the issue's comments, ignore any carrying the orchestrator marker, and relay through `answer` the first human comment posted after the latest marked comment that it has not relayed before, remembering what it relayed. An `answer` the daemon refuses with 409 because the task is no longer `waiting` or `blocked` SHALL be reported to the user and not retried. On accepting a proposal in a GitHub run the skill SHALL create the issue as a sub-issue of the root, add a dependency on the proposing task's issue, and pass `GH-<number>` as `nodeId`. The skill SHALL keep effect payloads out of the conversation except for a one-line count of what it applied.

#### Scenario: Drain after wait
- **WHEN** `wait` returns and `outbox` lists a `setState inProgress` for ENG-12 and a `comment` for ENG-13
- **THEN** the skill sets ENG-12 to the started-type state, posts the comment with its marker on ENG-13, and acknowledges both with the vendor ids before calling `wait` again

#### Scenario: GitHub states
- **WHEN** the outbox lists `setState done` for `GH-41`, `setState cancelled` for `GH-43`, and `setState inProgress` for `GH-42`, which is closed, under a policy with `inProgressLabel: "in-progress"`
- **THEN** `#41` is closed as completed, `#43` is closed as not planned, `#42` is reopened and labelled `in-progress`, and all three effects are acknowledged

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
