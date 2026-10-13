## ADDED Requirements

### Requirement: Reopen with cascade
`reopen` SHALL accept an optional `cascade` flag: a `cascade` field in the route body, `--cascade` on the CLI, and a parameter on the MCP tool. Without it, a reopen whose target has started non-milestone dependents reachable through milestones SHALL be refused with 409 and `blockers`. With it, the daemon SHALL compute the cascade plan, refuse with 409 naming the task when any job in the plan is `publishing`, and otherwise record the `operator.reopen` event with the plan, return `reset: [{ id, from }]`, and apply the plan in the next tick. A plain reopen SHALL return `reset` listing the milestones it resets.

#### Scenario: Plain reopen names the blockers
- **WHEN** a human reopens T1 without cascade while T2 is running
- **THEN** the response is 409 with `blockers` containing T2 and nothing changes

#### Scenario: Cascade returns the plan
- **WHEN** a human reopens T1 with cascade while T2 is running and MVP is submitted
- **THEN** the response lists T1 from `done`, T2 from `running`, and MVP from `submitted`, the `operator.reopen` event carries the same plan, and after the next tick all three are `unstarted`

#### Scenario: Cascade refused during publication
- **WHEN** a human reopens T1 with cascade while T2's job is `publishing`
- **THEN** the response is 409 naming T2 and no event other than the refusal is recorded

### Requirement: Proposals
The operator interface SHALL gain `proposals`, which lists proposals filtered by status with pending as the default, `accept_proposal` with `id`, optional `nodeId`, and optional `payload`, and `reject_proposal` with `id` and a required `note`. Each SHALL be recorded as an operator event. Accepting SHALL append a task node to the run's graph file whose id is `nodeId` when given and the proposal id otherwise, whose `deps` are the proposal's deps plus the proposing task, and whose payload is the proposal's title, description, acceptance criteria, labels, and scope merged with `payload`, plus `proposal` and `proposedBy`. When `proposals.joinMilestone` is true (the default) the node SHALL also be added to the `deps` of every gated milestone whose closure contains the proposing task. The file SHALL be validated and written atomically, reloaded, and the proposal marked `accepted` with the node id; on validation failure nothing SHALL be written and the proposal SHALL stay pending. Accepting a proposal whose node is already in the file SHALL mark it accepted without writing. Rejecting SHALL mark the proposal `rejected` with the note.

#### Scenario: Accept with a tracker id
- **WHEN** `T2-p1` with deps [T3] is accepted with `nodeId` ENG-77
- **THEN** the graph file gains task ENG-77 with deps [T3, T2] and the proposal's payload, the reload is compatible, and `T2-p1` is `accepted` with node ENG-77

#### Scenario: Accept without a node id
- **WHEN** `T2-p1` is accepted with no `nodeId`
- **THEN** the new node's id is `T2-p1`, it becomes ready only after T2 is done, and it runs after T2

#### Scenario: Join the proposer's milestone
- **WHEN** T2 is in the closure of the gated milestone MVP, MVP is submitted, and `T2-p1` is accepted with `joinMilestone` at its default
- **THEN** MVP's deps include the new node, the reload is compatible, and MVP is reset to `unstarted` until the node is done

#### Scenario: Reject
- **WHEN** `T2-p2` is rejected with a note
- **THEN** it is `rejected` with the note, the graph is unchanged, and it no longer appears under pending

#### Scenario: Accept is idempotent
- **WHEN** `T2-p1` is accepted twice
- **THEN** the second call reports it accepted with the same node and the graph file is not rewritten

### Requirement: Status report: proposals
`status` and the event-stream digest SHALL list `proposals`, every pending proposal with its id, proposing task, and title.

#### Scenario: Pending proposals visible
- **WHEN** T2 submitted with one proposal and nothing has decided it
- **THEN** `status` and the digest list `T2-p1` with task T2 and its title, and an accepted or rejected proposal is not listed
