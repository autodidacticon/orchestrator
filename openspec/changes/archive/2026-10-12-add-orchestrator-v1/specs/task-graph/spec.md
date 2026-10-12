## ADDED Requirements

### Requirement: Graph file loading
The system SHALL load the task graph from a JSON or YAML file whose nodes carry a stable `id`, a `kind` of `task` or `milestone`, an optional `gated` flag, a `deps` list of ids, and an opaque `payload`. The system SHALL compute a content hash of the loaded file as the graph revision `rev` and SHALL treat the loaded graph as immutable until the next load.

#### Scenario: Standard fixture loads
- **WHEN** the standard fixture with tasks T1 to T5 and the gated milestone MVP is loaded
- **THEN** the graph contains six nodes, MVP has kind `milestone` with `gated: true`, and `rev` is the content hash of the file

#### Scenario: Same content yields the same revision
- **WHEN** the same file content is loaded twice
- **THEN** both loads report the same `rev`

### Requirement: Graph validation
The system SHALL reject a graph that contains a dependency cycle, a self-loop, a duplicate id, or a dependency on an id that is not in the graph. When a cycle is found the rejection MUST report the ids along the cycle. The system SHALL accept graphs with multiple sink nodes.

#### Scenario: Cycle reported with its path
- **WHEN** a file declares A depends on B, B depends on C, and C depends on A
- **THEN** loading fails and the error lists the path A, B, C, A

#### Scenario: Dependency on unknown id
- **WHEN** a node lists a dependency id that no node declares
- **THEN** loading fails and the error names the node and the unknown id

#### Scenario: Duplicate id
- **WHEN** two nodes share an id
- **THEN** loading fails and the error names the id

#### Scenario: Multiple sinks accepted
- **WHEN** the file contains two nodes that nothing depends on
- **THEN** loading succeeds

### Requirement: Dependency semantics
Only `deps` SHALL impose ordering. A dependency SHALL count as satisfied when its status is `done`, or when its status is `cancelled` with `releasesDependents` set. A dependency in any other status SHALL NOT count as satisfied.

#### Scenario: Done satisfies
- **WHEN** T1 is done and T2 depends only on T1
- **THEN** T2's dependencies are satisfied

#### Scenario: Released cancellation satisfies
- **WHEN** T1 is cancelled with `releasesDependents: true` and T2 depends only on T1
- **THEN** T2's dependencies are satisfied

#### Scenario: Unreleased cancellation does not satisfy
- **WHEN** T1 is cancelled with `releasesDependents: false` and T2 depends only on T1
- **THEN** T2's dependencies are not satisfied

### Requirement: Ready frontier
The system SHALL compute `ready` as the set of nodes of kind `task` whose status is `unstarted` and whose dependencies are all satisfied. Milestones SHALL never appear in `ready`.

#### Scenario: Tasks without dependencies are ready
- **WHEN** the standard fixture is loaded with an empty overlay
- **THEN** `ready` is exactly T1 and T5

#### Scenario: Dependents become ready when dependencies complete
- **WHEN** T1 becomes done
- **THEN** `ready` includes T2 and T3 and excludes T4

#### Scenario: Milestones excluded
- **WHEN** T3 and T4 are done
- **THEN** MVP is not in `ready`

### Requirement: Milestone completion
The system SHALL compute `milestonesDue` as milestones whose status is `unstarted` and whose dependencies are all satisfied. For each due milestone the orchestrator SHALL set `done` when the milestone is not gated, and SHALL set `submitted` with `reviewVersion` incremented and the current integration head recorded as `integrationSha` when it is gated. Completion MUST be repeated within the same tick until `milestonesDue` is empty.

#### Scenario: Chained automatic milestones complete in one tick
- **WHEN** M1 depends on T1, M2 depends on M1, neither is gated, and T1 becomes done
- **THEN** after one tick both M1 and M2 are done

#### Scenario: Gated milestone is submitted with a pinned head
- **WHEN** T3 and T4 are done and MVP is gated
- **THEN** MVP is `submitted`, its `reviewVersion` is 1, and `integrationSha` equals the integration head at that moment

### Requirement: Terminal condition detection
The system SHALL report `finished` when no node is incomplete, where a node is incomplete unless its status is `done` or `cancelled`. The system SHALL report `stalled` when `ready` is empty, no launch is live, no node is `submitted`, and incomplete nodes remain. The system SHALL compute `stallRoots` as the incomplete nodes whose status is `failed` or `blocked`, together with incomplete nodes that depend on a node cancelled without `releasesDependents`.

#### Scenario: All work done
- **WHEN** every task and every milestone is done
- **THEN** `finished` is true and `stalled` is false

#### Scenario: Failed root task stalls the graph
- **WHEN** T1 is `failed` with attempts exhausted and no launches are live
- **THEN** `stalled` is true and `stallRoots` is exactly T1

#### Scenario: Unreleased cancellation surfaces dependents
- **WHEN** T1 is cancelled without release, T5 is done, and nothing is live
- **THEN** `stalled` is true and `stallRoots` includes T2 and T3

#### Scenario: Waiting agent is not a stall
- **WHEN** the only incomplete task is `waiting` on a human answer and its process is live
- **THEN** `stalled` is false and the task is listed in `openQuestions`

#### Scenario: Gated milestone under review is not a stall
- **WHEN** the only incomplete node is a milestone in `submitted`
- **THEN** `stalled` is false and the milestone is listed in `awaitingReview`

### Requirement: Stall diagnosability
On a quiescent state, where every `running` or `waiting` entry has a live process and an unexpired lease, no verifier result is unapplied, and `milestonesDue` is empty, the system SHALL guarantee for any acyclic graph that `stalled` implies `stallRoots` is non-empty.

#### Scenario: Property over reachable states
- **WHEN** random sequences of agent, verifier, and operator actions are applied through the real tick to random acyclic graphs
- **THEN** every resulting quiescent state that is `stalled` has a non-empty `stallRoots`

### Requirement: Graph revision pinning
Every launch SHALL record the `rev` of the graph snapshot its brief was composed from and SHALL compose the brief from that snapshot only.

#### Scenario: Launch records the revision
- **WHEN** a task is launched while snapshot rev R is active
- **THEN** the launch record and the brief both carry R

### Requirement: Reload compatibility
The system SHALL re-read the graph file when it changes and SHALL classify the differences against the active snapshot. A node is started when its status is `running`, `waiting`, `submitted`, or `done`. Adding a node, removing a node that is not started, and changing `deps`, `payload`, `kind`, or `gated` of a node that is not started SHALL be compatible. Removing a started node, changing `deps` or `kind` of a started node, or producing a graph that fails validation SHALL be incompatible. An incompatible reload MUST be rejected as a whole, the active snapshot MUST remain in force, and status MUST report `graphRejected` with the reasons. The overlay entry of a removed node SHALL be retained and the node SHALL never be scheduled.

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
