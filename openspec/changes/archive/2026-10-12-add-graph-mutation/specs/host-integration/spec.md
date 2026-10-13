## ADDED Requirements

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
