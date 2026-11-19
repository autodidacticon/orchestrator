## MODIFIED Requirements
### Requirement: Reload compatibility
The system SHALL re-read the graph file when it changes and SHALL classify the differences against the active snapshot. A task is started when its status is `running`, `waiting`, `submitted`, or `done`. Adding a node, removing a node that is not started, and changing `deps`, `payload`, `kind`, or `gated` of a node that is not started SHALL be compatible.

#### Scenario: Follow-up task added mid-run
- **WHEN** the file gains a new task T6 depending on T2 while T2 is running
- **THEN** the reload is accepted and T6 is `unstarted`

#### Scenario: Dependency added to a running task
- **WHEN** the file adds a dependency to T2 while T2 is running
- **THEN** the reload is rejected, the previous snapshot stays active, and status reports `graphRejected` naming T2

#### Scenario: Running task removed
- **WHEN** the file removes T2 while T2 is running
- **THEN** the reload is rejected and status reports `graphRejected` naming T2

#### Scenario: Cancel then remove
- **WHEN** T2 is cancelled and the file then removes T2
- **THEN** the reload is accepted and T2's overlay entry remains readable as an orphan

#### Scenario: Dependency added to a submitted milestone
- **WHEN** the file adds T7 to MVP's deps while MVP is `submitted` at review version 1
- **THEN** the reload is accepted, MVP is `unstarted` with `reviewVersion` still 1, and a `milestone.reset` event with reason `depsChanged` is recorded for MVP

#### Scenario: Payload edit to a running task is reported
- **WHEN** the file changes T2's description while T2 is running and nothing else changes
- **THEN** the reload is accepted and the classification lists T2 under `payloadChanged`

#### Scenario: Published task re-imported as a done external
- **WHEN** T1 is `done` and the file now declares T1 as `kind: external, done: true`
- **THEN** the reload is accepted, T1 is listed under `changed`, and T1's entry is still `done`

#### Scenario: Done task re-imported as an unfinished external
- **WHEN** T1 is `done` and the file now declares T1 as `kind: external, done: false`
- **THEN** the reload is rejected naming T1

#### Scenario: Running task re-imported as an external
- **WHEN** T2 is `running` and the file now declares T2 as `kind: external, done: true`
- **THEN** the reload is rejected naming T2

### Requirement: Revocability through milestones
`revocable` SHALL treat milestone dependents as transparent. The blockers of a `done` or `cancelled` node SHALL be exactly the non-milestone dependents whose status is `running`, `waiting`, `submitted`, or `done` that are reachable from the node through a chain of zero or more milestones, and a milestone SHALL never be a blocker.

#### Scenario: Done milestone is not a blocker
- **WHEN** T3 is done, MVP depends on T3 and is done, and nothing depends on MVP
- **THEN** `revocable` for T3 is ok and `resets` is exactly MVP

#### Scenario: Started task behind a milestone blocks
- **WHEN** T3 is done, MVP is done and depends on T3, and T8 is running and depends on MVP
- **THEN** `revocable` for T3 is refused with blockers exactly T8

#### Scenario: Cascade plan is the started closure
- **WHEN** in the standard fixture T1, T3, and T4 are done, T2 is running, MVP is submitted, and T5 is unstarted
- **THEN** the cascade plan for T1 lists T1, T2, T3, T4, and MVP with their statuses as `from`, lists T4 and MVP before T2 and T3, and excludes T5

#### Scenario: Property over random graphs
- **WHEN** random overlays are applied to random acyclic graphs of tasks and milestones
- **THEN** the blockers of every done or cancelled node equal the started non-milestone nodes reachable from it along paths whose intermediate nodes are all milestones, and never include a milestone

## ADDED Requirements

### Requirement: Reload compatibility: milestones are never started
A milestone SHALL never count as started for reload compatibility, so its `deps`, `payload`, and `gated` flag may change on any reload.

#### Scenario: Dependency added to a submitted milestone is compatible
- **WHEN** T1 to T4 are `done`, MVP is `submitted`, and the file adds T5 to MVP's deps
- **THEN** the classification is compatible and lists MVP under `changed`

### Requirement: Reload compatibility: incompatible changes
Removing a started task, changing `deps` or `kind` of a started task, or producing a graph that fails validation SHALL be incompatible, with one exception: a task whose status is `done` MAY become an `external` node whose `done` flag is true, which is what a re-import after the run has published the task produces; its entry SHALL be left unchanged and the node SHALL be listed under `changed`.

#### Scenario: Kind change of a running task
- **WHEN** T2 is `running` and the file now declares T2 as `kind: milestone`
- **THEN** the reload is rejected with reason code `kindChangedStarted` naming T2

### Requirement: Reload compatibility: done externals that stay incompatible
A done task becoming an external with `done: false`, and an external becoming a task while its entry is `done`, SHALL remain incompatible.

#### Scenario: Done task declared an open external
- **WHEN** T1 is `done`, T2 is `running`, and the file now declares T1 as `kind: external, done: false`
- **THEN** the reload is rejected and its only reason is `kindChangedStarted` naming T1

### Requirement: Reload compatibility: milestone reset on changed deps
A compatible reload that changes the `deps` of a milestone whose status is `done` or `submitted` SHALL reset that milestone to `unstarted` with event `milestone.reset` and reason `depsChanged`, retaining its review history.

#### Scenario: Submitted milestone resets and resubmits
- **WHEN** MVP is `submitted` at review version 1 and a reload adds T5, which is `done`, to MVP's deps
- **THEN** a `milestone.reset` event for MVP is recorded with reason `depsChanged`, `from` `submitted` and `reviewVersion` 1, and MVP is `submitted` again at review version 2 in the same tick

### Requirement: Reload compatibility: payload changes of started tasks
A compatible classification SHALL list `payloadChanged`, the ids of started tasks whose `payload` differs from the active snapshot.

#### Scenario: Title edit of a running task listed
- **WHEN** T1 is `done`, T2 is `running`, and the file changes only T2's title
- **THEN** the classification is compatible and lists T2 under both `changed` and `payloadChanged`

#### Scenario: Milestone deps change is not a payload change
- **WHEN** T1 to T4 are `done`, MVP is `submitted`, and the file adds T5 to MVP's deps
- **THEN** the classification is compatible and `payloadChanged` is empty

### Requirement: Reload compatibility: rejection keeps the active snapshot
An incompatible reload MUST be rejected as a whole, the active snapshot MUST remain in force, and status MUST report `graphRejected` with the reasons.

#### Scenario: Rejected reload reported in status
- **WHEN** T1 is `running` and the file adds T5 to T1's deps
- **THEN** status reports `graphRejected` with a reason naming T1, and `graphRev` is still the rev of the active snapshot

### Requirement: Reload compatibility: removed nodes
The overlay entry of a removed node SHALL be retained and the node SHALL never be scheduled.

#### Scenario: Removed cancelled task stays out of the ready list
- **WHEN** T2 is `cancelled` without releasing its dependents and the file removes T2
- **THEN** the classification is compatible and lists T2 under `removed`, T2's entry is still `cancelled`, and T2 never appears in `ready`

### Requirement: Revocability: milestone resets
The result of `revocable` SHALL also list `resets`, every milestone reachable downstream from the node whose status is `done` or `submitted`.

#### Scenario: Submitted milestone listed as a reset
- **WHEN** T1 to T4 are `done` and MVP is `submitted`
- **THEN** `revocable` for T4 is ok with `resets` exactly MVP

### Requirement: Cascade plan
The system SHALL compute a cascade plan for a node as the node itself together with every started node reachable downstream through any chain of dependents, tasks and milestones alike, each with its current status as `from`, ordered dependents before their dependencies.

#### Scenario: Nothing started downstream
- **WHEN** in the standard fixture only T1 is `done`
- **THEN** the cascade plan for T1 is exactly T1 with `from` `done`
