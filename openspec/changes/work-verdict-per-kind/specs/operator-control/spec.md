## ADDED Requirements

### Requirement: Work verdict
The daemon SHALL classify, per runner kind, whether a worker loop of that kind has work in sight. The verdict SHALL be the first class that applies, in this order: `finished` (the run is finished), `stalled` (the run is stalled), `paused` (the run is paused, so every new claim answers 404), `claim`, `standby`, `human`, `idle`. The order SHALL be exported as `WORK_VERDICTS`, with `strongestVerdict(list)` answering the word of a list that comes first in it.

#### Scenario: Finished whatever else holds
- **WHEN** the run is finished while it is also paused and a launch of the kind is claimable
- **THEN** the verdict of every kind is `finished`

#### Scenario: Stalled
- **WHEN** the run is stalled and not finished
- **THEN** the verdict of every kind is `stalled`

#### Scenario: Paused
- **WHEN** the run is paused with a `claude-code` launch parked
- **THEN** the verdict of `claude-code` is `paused` and a claim answers 404 with `paused: true`

#### Scenario: Strongest verdict
- **WHEN** `strongestVerdict` is called with `['human', 'claim', 'idle']`, with `[]`, and with `['nonsense', 'standby']`
- **THEN** it answers `claim`, `idle`, and `standby`

### Requirement: Work verdict: claim and standby
After `finished`, `stalled` and `paused`, the verdict of a kind SHALL be `claim` when a launch of the kind is claimable. Otherwise it SHALL be `standby` when a launch of the kind is being prepared (its prepare command runs, or its task waits for a prepare retry) or worked, or when any task is under verification.

#### Scenario: Claimable
- **WHEN** a `codex` launch is parked
- **THEN** the verdict of `codex` is `claim`

#### Scenario: Being prepared
- **WHEN** the prepare command of a `codex` launch runs, or a `codex` task waits for a prepare retry
- **THEN** the verdict of `codex` is `standby` with `preparing` 1

#### Scenario: Under verification
- **WHEN** a task has submitted and waits on the verifier, and nothing else is in sight
- **THEN** the verdict of every kind is `standby`

### Requirement: Work verdict: human and idle
When no earlier class applies, the verdict of a kind SHALL be `human` when a question is open or a milestone awaits review, and `idle` otherwise. Tasks under verification SHALL not count as reviews.

#### Scenario: Open question
- **WHEN** nothing is in sight for a kind and one question is open
- **THEN** its verdict is `human`

#### Scenario: Milestone awaiting review
- **WHEN** a gated milestone awaits review and nothing else is in sight
- **THEN** the verdict of every kind is `human`

#### Scenario: Nothing at all
- **WHEN** nothing applies for a kind
- **THEN** its verdict is `idle`

### Requirement: Work verdict: working launches
`working` SHALL count the live launches of a kind whose task is `running` or `waiting` on that launch, the predicate `claim()` uses for a held launch. A live launch whose task has submitted, or whose lease was cleared, SHALL not count.

#### Scenario: Waiting on a question
- **WHEN** a claimed `claude-code` launch's task waits on an unanswered question
- **THEN** it counts in `working` and the verdict of `claude-code` stays `standby`

#### Scenario: Blocked by the wait limit
- **WHEN** the wait limit has blocked that task and a tick has ended its launch while a `codex` task is still parked
- **THEN** `working` of `claude-code` is 0 and its verdict is `human`

#### Scenario: Submitted
- **WHEN** a live launch's task has submitted and the row is not yet ended
- **THEN** the launch is not counted in `working`

#### Scenario: Worker gone
- **WHEN** a claimed launch's worker stops calling
- **THEN** the launch counts in `working` until its lease expiry ends it

### Requirement: Status report: work verdict per kind
The status SHALL carry `workByKind`: for every runner kind `{ verdict, claimable, preparing, working }`, where `claimable` and `preparing` are the kind's entries of `claimableByKind` and `preparingByKind`. `claimableByKind` and `preparingByKind` SHALL stay.

#### Scenario: Two kinds parked
- **WHEN** one `claude-code` task and one `codex` task are parked in a pull run
- **THEN** `workByKind` is `claim` with `claimable` 1 for both and `idle` with zero counts for `opencode`

#### Scenario: Claimed
- **WHEN** a worker claims the `claude-code` launch
- **THEN** that kind is `{ verdict: 'standby', claimable: 0, preparing: 0, working: 1 }`

### Requirement: Status report: work verdict without a graph
Before a graph is loaded, the status body and the digest SHALL carry `workByKind` with every runner kind at zero counts and the verdict `idle`, or `paused` when the run is paused.

#### Scenario: No graph
- **WHEN** `GET /v1/status` and `GET /v1/events` are read before a graph is loaded
- **THEN** both carry every kind as `{ verdict: 'idle', claimable: 0, preparing: 0, working: 0 }`

#### Scenario: No graph, paused
- **WHEN** `POST /v1/pause` is called before a graph is loaded
- **THEN** both bodies carry every kind with the verdict `paused`
