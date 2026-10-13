# Task Graph Specification

## Purpose
Loading, validating, and querying the dependency graph of tasks, milestones, and external nodes that stand in for work tracked outside the orchestrator: the derived ready frontier, milestone completion, stall detection, graph revisions, and reload compatibility, where milestones are transparent to the reopen guard and to the cascade plan, so that a milestone never blocks a reopen and never counts as started for reload, and a cascade plan reaches every started node downstream through tasks and milestones alike.

## Requirements

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

### Requirement: Critical path length
The system SHALL compute, for every node, its critical path length: the number of task nodes on the longest chain of dependents below it. Milestone and external nodes SHALL be passed through and SHALL contribute zero, so a chain continues through a milestone to its dependents. A node with no dependents SHALL have length zero. The lengths SHALL be computed from the graph alone, once per graph revision, and cached with the loaded graph.

#### Scenario: Standard fixture lengths
- **WHEN** the standard fixture is loaded
- **THEN** the lengths are T1 2, T2 1, T3 0, T4 0, T5 0, and MVP 0

#### Scenario: Milestone passed through
- **WHEN** milestone M1 depends on T1 and task T9 depends on M1
- **THEN** T1's length is 1 and M1's length is 1

#### Scenario: Monotone along dependencies
- **WHEN** random acyclic graphs are generated
- **THEN** for every dependency edge the dependency's length is at least the dependent's length, plus one when the dependent is a task
