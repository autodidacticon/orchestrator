## MODIFIED Requirements

### Requirement: Graph file loading
The system SHALL load the task graph from a JSON or YAML file whose nodes carry a stable `id`, a `kind` of `task`, `milestone`, or `external`, an optional `gated` flag, an optional `done` flag that is meaningful only for `external` nodes, a `deps` list of ids, and an opaque `payload`. The system SHALL compute a content hash of the loaded file as the graph revision `rev` and SHALL treat the loaded graph as immutable until the next load.

#### Scenario: Standard fixture loads
- **WHEN** the standard fixture with tasks T1 to T5 and the gated milestone MVP is loaded
- **THEN** the graph contains six nodes, MVP has kind `milestone` with `gated: true`, and `rev` is the content hash of the file

#### Scenario: Same content yields the same revision
- **WHEN** the same file content is loaded twice
- **THEN** both loads report the same `rev`

#### Scenario: External node loads with its done flag
- **WHEN** a file declares `{ id: OPS-7, kind: external, done: true }` and T2 depends on OPS-7
- **THEN** the graph contains OPS-7 with kind `external` and `done: true`, and validation passes

### Requirement: Dependency semantics
Only `deps` SHALL impose ordering. A dependency SHALL count as satisfied when its status is `done`, when its status is `cancelled` with `releasesDependents` set, or when it is an `external` node whose `done` flag is true. A dependency in any other state SHALL NOT count as satisfied.

#### Scenario: Done satisfies
- **WHEN** T1 is done and T2 depends only on T1
- **THEN** T2's dependencies are satisfied

#### Scenario: Released cancellation satisfies
- **WHEN** T1 is cancelled with `releasesDependents: true` and T2 depends only on T1
- **THEN** T2's dependencies are satisfied

#### Scenario: Unreleased cancellation does not satisfy
- **WHEN** T1 is cancelled with `releasesDependents: false` and T2 depends only on T1
- **THEN** T2's dependencies are not satisfied

#### Scenario: External done satisfies, external open does not
- **WHEN** T2 depends only on the external node OPS-7
- **THEN** T2's dependencies are satisfied when OPS-7 has `done: true` and are not satisfied when it has `done: false`

## ADDED Requirements

### Requirement: External nodes
An `external` node SHALL never appear in `ready` or `milestonesDue`, SHALL never hold an overlay entry other than the default, SHALL be treated as not started for reload compatibility so that its `done` flag and `deps` may change on any reload, and SHALL be listed by status under `external` with its `done` flag. An external node that is not done and blocks incomplete work SHALL be counted among `stallRoots` when the run is otherwise stalled.

#### Scenario: Never scheduled
- **WHEN** an external node has no deps and `done: false`
- **THEN** it is not in `ready` and no launch is ever created for it

#### Scenario: Re-import flips the flag
- **WHEN** a reload changes OPS-7 from `done: false` to `done: true` while T2, which depends on it, is unstarted
- **THEN** the reload is compatible and T2 becomes ready

#### Scenario: Open external blocker is a stall root
- **WHEN** the only incomplete task depends on an external node with `done: false` and nothing is live
- **THEN** `stalled` is true and `stallRoots` includes that task, naming the external node as the cause
