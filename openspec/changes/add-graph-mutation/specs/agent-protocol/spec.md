## ADDED Requirements

### Requirement: Revision context in the brief
When a task is relaunched after reopen, uncancel, or a cascade reset, its brief SHALL carry a `revision` context with `cause` of `reopened` or `upstreamReopened`, `upstream` naming the reopened task when the cause is `upstreamReopened`, `priorLaunchId`, `priorBranch`, and, when they exist, `priorPublishedSha` and `priorReportSummary`. The brief SHALL state that the prior published commit remains on the integration branch and is contained in `baseSha`, and SHALL instruct the agent to revise the prior work rather than redo it. The context SHALL be stored on the overlay entry at reset and cleared when the launch goes live, like other attempt context.

#### Scenario: Cascade dependent is briefed to revise
- **WHEN** T2 was published at sha P with summary S and is reset by a cascade reopen of T1
- **THEN** T2's next brief carries `revision` with cause `upstreamReopened`, upstream T1, `priorPublishedSha` P, and `priorReportSummary` S, and states that P is contained in the new `baseSha`

#### Scenario: Killed dependent is briefed with its branch
- **WHEN** T2 was running on branch `task/T2/l1` and is reset by a cascade
- **THEN** T2's next brief carries `revision` with `priorBranch` `task/T2/l1` and no `priorPublishedSha`

### Requirement: Proposals in the report
The submit report MAY carry `proposals`, a list of `{ title, description, acceptanceCriteria, deps?, scope?, labels? }` where `title`, `description`, and at least one acceptance criterion are required and every id in `deps` MUST name a node in the launch's graph revision. A report that violates this SHALL be answered 400 as malformed and the task SHALL stay `running`. `followUps` SHALL remain free text. When the report is accepted each proposal SHALL be stored as pending with id `<taskId>-p<n>`, where `n` counts the task's proposals from one, and the orchestrator SHALL NOT add any node to the graph on its own.

#### Scenario: Proposals stored pending
- **WHEN** T2's submit report carries two valid proposals
- **THEN** T2 is `submitted`, proposals `T2-p1` and `T2-p2` are pending, and the graph is unchanged

#### Scenario: Malformed proposal rejects the report
- **WHEN** a submit report carries a proposal with no acceptance criteria or with a dependency on an id the graph does not have
- **THEN** the response is 400 naming the proposal and the task is still `running`

### Requirement: Payload change notice
When a compatible reload changes the `payload` of a task whose status is `running` or `waiting`, the orchestrator SHALL append the notice `{ kind: 'payloadChanged', rev }` to its live launch's inbox, where `rev` is the new graph revision, unless `graph.payloadChangedNotice` is false. The launch's pinned brief and `graphRev` SHALL NOT change, and the next launch of the task SHALL compose its brief from the new payload. Dependency edits to started tasks SHALL remain incompatible.

#### Scenario: Notice delivered on the next inbox call
- **WHEN** the graph file changes T2's description while T2 is running and the reload is accepted at revision R
- **THEN** T2's next `inbox` call returns `{ kind: 'payloadChanged', rev: R }` and the brief in its worktree is unchanged

#### Scenario: Notice disabled by configuration
- **WHEN** `graph.payloadChangedNotice` is false and the same edit is reloaded
- **THEN** the inbox stays empty

#### Scenario: Next launch uses the new payload
- **WHEN** T2 fails after the notice and is relaunched
- **THEN** the new brief carries the edited description
