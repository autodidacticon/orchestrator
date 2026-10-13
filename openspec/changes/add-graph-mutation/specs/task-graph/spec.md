## MODIFIED Requirements

### Requirement: Reload compatibility
The system SHALL re-read the graph file when it changes and SHALL classify the differences against the active snapshot. A task is started when its status is `running`, `waiting`, `submitted`, or `done`. A milestone SHALL never count as started for reload compatibility, so its `deps`, `payload`, and `gated` flag may change on any reload. Adding a node, removing a node that is not started, and changing `deps`, `payload`, `kind`, or `gated` of a node that is not started SHALL be compatible. Removing a started task, changing `deps` or `kind` of a started task, or producing a graph that fails validation SHALL be incompatible. A compatible reload that changes the `deps` of a milestone whose status is `done` or `submitted` SHALL reset that milestone to `unstarted` with event `milestone.reset` and reason `depsChanged`, retaining its review history. A compatible classification SHALL list `payloadChanged`, the ids of started tasks whose `payload` differs from the active snapshot. An incompatible reload MUST be rejected as a whole, the active snapshot MUST remain in force, and status MUST report `graphRejected` with the reasons. The overlay entry of a removed node SHALL be retained and the node SHALL never be scheduled.

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

## ADDED Requirements

### Requirement: Revocability through milestones
`revocable` SHALL treat milestone dependents as transparent. The blockers of a `done` or `cancelled` node SHALL be exactly the non-milestone dependents whose status is `running`, `waiting`, `submitted`, or `done` that are reachable from the node through a chain of zero or more milestones, and a milestone SHALL never be a blocker. The result SHALL also list `resets`, every milestone reachable downstream from the node whose status is `done` or `submitted`. The system SHALL compute a cascade plan for a node as the node itself together with every started node reachable downstream through any chain of dependents, tasks and milestones alike, each with its current status as `from`, ordered dependents before their dependencies.

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
