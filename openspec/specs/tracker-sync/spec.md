# Tracker Sync Specification

## Purpose
A durable outbox of tracker-bound effects derived from the daemon's own transitions, so that a run imported from an issue tracker is mirrored back to it without the daemon ever contacting the tracker: the vendor-agnostic effect kinds and the marker that identifies an orchestrator comment, the policy that decides when effects are derived and the done semantics that decide when a task's issue is closed, and the contract a drainer such as the run skill follows to apply and acknowledge effects.

## Requirements

### Requirement: Durable outbox
The daemon SHALL keep tracker-bound effects in a durable `outbox` table with `id`, `sourceSeq`, `taskId`, `kind`, `payload`, `status` of `pending`, `applied`, or `failed`, `attempts`, `result`, `error`, `createdAt`, and `appliedAt`. Effects SHALL be derived from the daemon's own transitions and inserted in the same store transaction as the `transition` event they mirror, with `sourceSeq` equal to that event's sequence number. The key `(sourceSeq, taskId, kind)` SHALL be unique so that derivation is idempotent. The daemon SHALL never contact a tracker; a drainer outside the daemon applies effects and acknowledges them.

#### Scenario: Effect commits with its transition
- **WHEN** A becomes `running` and the policy yields a `setState` effect
- **THEN** the outbox row and the transition event are committed in one transaction and the row's `sourceSeq` equals the event's `seq`

#### Scenario: Re-derivation is idempotent
- **WHEN** derivation runs twice for the same source event, issue, and kind
- **THEN** the outbox holds one row for that key

### Requirement: Effect kinds
Effects SHALL be vendor-agnostic. `setState` SHALL carry `state` of `inProgress`, `done`, or `cancelled`. `comment` SHALL carry `body` and `marker`. Every effect SHALL name its issue by the node id and SHALL carry the node payload's `url` when present. The marker SHALL be the line `— orchestrator run <runId> · event <sourceSeq>`, where `runId` identifies the run, and SHALL be unique per issue and comment; a drainer appends it as the last line of every comment it posts.

#### Scenario: Effect names its issue
- **WHEN** an effect is derived for node ENG-12 whose payload carries `url`
- **THEN** the effect's payload carries `issue: ENG-12` and that `url`

#### Scenario: Marker identifies the comment
- **WHEN** two comments are derived for the same issue from events 40 and 57
- **THEN** their markers differ in the event number and both carry the run id

### Requirement: Tracker policy
Effects SHALL be derived only when `tracker.enabled` permits: `never` yields none; `auto` (default) yields effects only when a tracker is recorded in the store; `always` yields effects whether or not one is recorded. In every mode an effect SHALL be derived only for a node whose payload carries `url` or `trackerState`. A run from a hand-written graph file with no tracker recorded SHALL produce no effects. The policy, with `tracker.doneAt`, `parentInProgress`, `commentOnDone`, `commentOnFail`, `answersFromComments`, `maxAttempts`, and the run id, SHALL be reported to drainers alongside pending effects.

#### Scenario: Untracked run produces nothing
- **WHEN** the standard fixture runs to completion with no tracker recorded
- **THEN** the outbox is empty throughout

#### Scenario: Node without identity is skipped
- **WHEN** a tracker is recorded and a task T9 was added to the graph by hand with no `url` and no `trackerState`
- **THEN** T9's transitions derive no effects while its imported siblings' transitions do

### Requirement: State effects
The daemon SHALL derive `setState inProgress` when a task enters `running`; `setState done` when a task becomes `done`, subject to `tracker.doneAt`; `setState cancelled` when a node becomes `cancelled`; and `setState done` when a milestone becomes `done`, by acceptance or by automatic completion. When `tracker.parentInProgress` is true (default) a task entering `running` SHALL also derive `setState inProgress` for every milestone that lists the task in its `deps`. A `setState` SHALL be derived only when its state differs from the last `setState` recorded in the outbox for that issue, so that a task's first launch yields one `inProgress`, retries and conflict relaunches yield none, the parent follows its first starting child, and a reopened task is set to `inProgress` again when it relaunches.

#### Scenario: First launch only
- **WHEN** A starts, fails its first attempt, and is relaunched
- **THEN** the outbox holds exactly one `setState inProgress` for A

#### Scenario: Parent follows the first child
- **WHEN** epic E was imported with children A and B, and A starts, then B starts
- **THEN** one `setState inProgress` is derived for E, at A's start

#### Scenario: Parent policy off
- **WHEN** `tracker.parentInProgress` is false and A starts
- **THEN** no effect is derived for E

#### Scenario: Cancellation mirrors
- **WHEN** a human cancels B
- **THEN** a `setState cancelled` is derived for B

### Requirement: Done semantics
With `tracker.doneAt` at `integration` (default) a task's `setState done` SHALL be derived when the task becomes `done`, that is when its work is published. With `milestoneAccepted` a done task in the closure of a gated milestone SHALL instead derive a comment naming its published sha, and its `setState done` SHALL be derived when the first gated milestone whose closure contains it is accepted; a done task in no gated milestone's closure SHALL derive `setState done` at publication in either mode. A milestone's own issue SHALL become `done` only when the milestone becomes `done`.

#### Scenario: Done at integration
- **WHEN** A is published with `doneAt` at `integration`
- **THEN** `setState done` for A is derived in the transaction that sets A `done`, and nothing is derived for E

#### Scenario: Done at acceptance
- **WHEN** `doneAt` is `milestoneAccepted`, A is published, and E is later accepted
- **THEN** A's publication derives a comment `integrated as <sha>` and no state change, and E's acceptance derives `setState done` for A and for E

#### Scenario: Task outside a gated milestone
- **WHEN** `doneAt` is `milestoneAccepted` and T5, which no gated milestone depends on, is published
- **THEN** `setState done` for T5 is derived at publication

### Requirement: Comment effects
The daemon SHALL derive a `comment` when: a task enters `waiting`, or enters `blocked` with a question delivered through the fallback file, with the question verbatim and its options; a task becomes `blocked` for any other reason, with the reason kind and message, the missing slots for `insufficientSpec`, and `whatWouldUnblock` when the last fail report carries one; a gated milestone becomes `submitted`, with the pinned sha, the tag, the diff stat against the baseline, and the closure tasks with their published shas and summaries; a milestone is accepted, with the sha and version; and a milestone is rejected, with the note. A `waiting` to `blocked` transition that preserves the same question SHALL NOT derive a second comment. A done task SHALL derive a comment only when `tracker.commentOnDone` is true (default false) or `doneAt` is `milestoneAccepted`; a `failed` transition SHALL derive a comment with the failure reason only when `tracker.commentOnFail` is true (default false).

#### Scenario: Question is mirrored
- **WHEN** A blocks with the question "Use REST or GraphQL?" and options REST and GraphQL
- **THEN** a comment for A is derived whose body contains the question and both options

#### Scenario: Timed-out question is not repeated
- **WHEN** A's question passes `maxWait` and A becomes `blocked` with the same question
- **THEN** no new comment is derived for A

#### Scenario: Exhaustion is mirrored
- **WHEN** A fails its last attempt with `whatWouldUnblock` "need staging credentials"
- **THEN** a comment for A is derived naming the exhaustion and "need staging credentials"

#### Scenario: Submitted milestone is mirrored
- **WHEN** E becomes `submitted` at version 1
- **THEN** a comment for E is derived with the pinned sha, `milestone/E/v1`, the diff stat, and every closure task with its published sha and summary

#### Scenario: Optional comments are off by default
- **WHEN** A fails once and is retried, then is published, with the default policy
- **THEN** no comment is derived for either event

### Requirement: Drainer contract
A drainer SHALL read pending effects in `id` order and apply each through the tracker. It SHALL acknowledge an applied effect with the vendor result, and SHALL reject a failed one with the error. On rejection the daemon SHALL increase `attempts` and keep the effect `pending` while `attempts` is below `tracker.maxAttempts` (default 3), and SHALL mark it `failed` at the cap. Effects for one issue SHALL be applied in `id` order; after a rejection the drainer SHALL leave that issue's later effects for the next drain. Before posting a comment the drainer SHALL look for an existing comment on the issue carrying the same marker and, when found, SHALL acknowledge with that comment's id instead of posting. An acknowledgement for an effect that is already `applied` SHALL change nothing and SHALL return the stored result.

#### Scenario: Retry until the cap
- **WHEN** an effect is rejected three times with `maxAttempts` 3
- **THEN** it is returned by the drains after the first two rejections and is `failed` with the last error after the third

#### Scenario: Later effect waits for the earlier one
- **WHEN** A has a pending `setState inProgress` that is rejected and a later `setState done`
- **THEN** the drainer does not apply the `done` in that drain

#### Scenario: Duplicate acknowledgement
- **WHEN** an applied effect is acknowledged again
- **THEN** its status and result are unchanged
