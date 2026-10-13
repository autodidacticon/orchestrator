# Scheduling Policy Specification

## Purpose
How ready candidates are ordered and filtered for admission: the configurable ordering chain `scheduling.order`, applied as one stable lexicographic sort of registered stages (`criticalPath`, `priority`, `fifo` by default) with resumable waiting tasks admitted ahead of it; the `scope` a task may declare in its payload as path globs relative to the repository root; the conservative overlap rule that compares static prefixes so that two scopes overlap whenever they could touch the same files; the admission filter, on by default through `scheduling.scopes`, that skips for the tick any candidate whose scope overlaps a scope held by a running, waiting, submitted, or claimable task or by a candidate admitted earlier in the same pass; and the deferred candidates that `status` reports with the reason and the ids they overlap.

## Requirements

### Requirement: Ordering chain
The orchestrator SHALL order ready candidates for admission by a configurable chain of stages, `scheduling.order`, applied as one stable lexicographic sort: the first stage decides, each later stage breaks ties left by the stages before it, and candidates still tied after the last stage keep graph file order. The default chain SHALL be `criticalPath`, `priority`, `fifo`. Resumable waiting tasks SHALL be admitted before any ordered candidate and SHALL NOT be ordered by the chain. A stage name that is not registered SHALL fail configuration validation naming the stage.

#### Scenario: Default chain on the standard fixture
- **WHEN** the standard fixture is loaded with the default chain and nothing has run
- **THEN** T1 is admitted before T5, and once T1 is done T2 is admitted before T3

#### Scenario: Ties fall through
- **WHEN** two ready tasks have the same critical path length and no priority
- **THEN** they are admitted in graph file order

#### Scenario: Resumables first
- **WHEN** capacity is one, a waiting task has an answer persisted, and a ready task has a longer critical path
- **THEN** the waiting task is resumed and the ready task waits for the next free slot

#### Scenario: Unknown stage rejected
- **WHEN** the configuration lists a stage named `nope`
- **THEN** loading the configuration fails naming `nope`

### Requirement: Critical path stage
The `criticalPath` stage SHALL rank a candidate by its critical path length as defined by the task graph, longer first.

#### Scenario: Longer chain first
- **WHEN** T1 has two task dependents in a chain below it and T5 has none
- **THEN** `criticalPath` places T1 before T5

### Requirement: Priority stage
The `priority` stage SHALL read `priority` from the candidate's payload as a number where a lower number is more urgent. A candidate whose priority is absent or not a finite number SHALL sort after every candidate with a numeric priority.

#### Scenario: Lower number first
- **WHEN** two ready tasks have equal critical path length and priorities 1 and 3
- **THEN** the task with priority 1 is admitted first

#### Scenario: Missing priority last
- **WHEN** two ready tasks have equal critical path length and only one has a priority
- **THEN** the task with a priority is admitted first

### Requirement: FIFO stage
The `fifo` stage SHALL rank candidates by graph file order. A chain consisting only of `fifo` SHALL reproduce the previous first-in first-out admission.

#### Scenario: v1 order restored
- **WHEN** `scheduling.order` is `['fifo']`
- **THEN** ready tasks are admitted in graph file order regardless of critical path or priority

### Requirement: Scope declaration
A task MAY carry `scope`, a list of path globs relative to the repository root, in its payload. A present `scope` that is not a list of non-empty strings SHALL fail graph validation naming the node. A task without a scope, or with an empty list, SHALL be unconstrained by scopes.

#### Scenario: Scope loads from the graph file
- **WHEN** a node declares `scope: ['src/api/**', 'package.json']`
- **THEN** the loaded node's payload carries that list

#### Scenario: Malformed scope rejected
- **WHEN** a node declares `scope: 'src/**'`
- **THEN** loading fails and the error names the node

### Requirement: Scope overlap rule
Two globs SHALL overlap iff the static prefix of one is a path-prefix of the static prefix of the other or the two are equal, where the static prefix is the longest leading run of path segments containing none of `*`, `?`, `[`, `{`. A glob whose static prefix is empty, such as `**` or `*`, SHALL overlap every glob. Two scopes SHALL overlap iff any glob of one overlaps any glob of the other.

#### Scenario: Prefix overlaps
- **WHEN** one scope is `src/**` and the other is `src/api/handlers.ts`
- **THEN** they overlap

#### Scenario: Disjoint siblings do not overlap
- **WHEN** one scope is `src/api/**` and the other is `src/ui/**`
- **THEN** they do not overlap

#### Scenario: Glob characters end the static prefix
- **WHEN** one scope is `src/{api,ui}/**` and the other is `src/ui/**`
- **THEN** they overlap, because the static prefix of the first is `src`

#### Scenario: Bare wildcard overlaps everything
- **WHEN** one scope is `*` and the other is `docs/README.md`
- **THEN** they overlap

### Requirement: Scope filter at admission
When `scheduling.scopes` is enabled, which is the default, the orchestrator SHALL walk the ordered candidates and SHALL skip for this tick any candidate whose scope overlaps the scope of a task that holds its scope or of a candidate admitted earlier in the same pass. A task holds its scope while it is `running`, `waiting`, or `submitted`, and while it has a claimable launch; it releases it when its work is published or when it leaves those states for `failed`, `blocked`, `cancelled`, or `unstarted`. A skipped candidate SHALL be recorded as deferred with reason `scopeOverlap` and the ids it overlaps. When `scheduling.scopes` is disabled, nothing SHALL be deferred.

#### Scenario: Deferred while the blocker runs
- **WHEN** T2 with scope `src/api/**` is running and T3 with scope `src/api/users/**` becomes ready
- **THEN** T3 is not launched, it is recorded as deferred with reason `scopeOverlap` and `with` containing T2, and it is launched on the first tick after T2's work is published

#### Scenario: Overlapping siblings launch one at a time
- **WHEN** T2 and T3 are both ready with the same scope, capacity is two, and nothing is running
- **THEN** only the first in chain order is launched and the other is deferred with it

#### Scenario: Waiting, submitted, and claimable tasks hold their scope
- **WHEN** the only task overlapping a ready candidate is `waiting` on a question, is `submitted` and awaiting verification, or has a claimable launch
- **THEN** the candidate is deferred

#### Scenario: Scopes disabled
- **WHEN** `scheduling.scopes` is false and two overlapping tasks are ready with free capacity
- **THEN** both are launched and nothing is deferred
