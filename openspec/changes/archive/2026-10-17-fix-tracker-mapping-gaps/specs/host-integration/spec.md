## MODIFIED Requirements

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
