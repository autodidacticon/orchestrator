## MODIFIED Requirements

### Requirement: Reload compatibility
The system SHALL re-read the graph file when it changes and SHALL classify the differences against the active snapshot. A task is started when its status is `running`, `waiting`, `submitted`, or `done`. A milestone SHALL never count as started for reload compatibility, so its `deps`, `payload`, and `gated` flag may change on any reload. Adding a node, removing a node that is not started, and changing `deps`, `payload`, `kind`, or `gated` of a node that is not started SHALL be compatible. Removing a started task, changing `deps` or `kind` of a started task, or producing a graph that fails validation SHALL be incompatible, with one exception: a task whose status is `done` MAY become an `external` node whose `done` flag is true, which is what a re-import after the run has published the task produces; its entry SHALL be left unchanged and the node SHALL be listed under `changed`. A done task becoming an external with `done: false`, and an external becoming a task while its entry is `done`, SHALL remain incompatible. A compatible reload that changes the `deps` of a milestone whose status is `done` or `submitted` SHALL reset that milestone to `unstarted` with event `milestone.reset` and reason `depsChanged`, retaining its review history. A compatible classification SHALL list `payloadChanged`, the ids of started tasks whose `payload` differs from the active snapshot. An incompatible reload MUST be rejected as a whole, the active snapshot MUST remain in force, and status MUST report `graphRejected` with the reasons. The overlay entry of a removed node SHALL be retained and the node SHALL never be scheduled.

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
