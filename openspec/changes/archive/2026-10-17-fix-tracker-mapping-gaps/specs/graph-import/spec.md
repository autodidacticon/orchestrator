## MODIFIED Requirements

### Requirement: Mapping rules
The import SHALL map: every child of the root with state `open` to a task whose id is the tracker key; every `blockedBy` edge between two tasks to a dependency; every `blockedBy` target outside the child set, and every child with state `done`, `cancelled`, or `inProgress`, to an `external` node whose `done` flag is true for state `done` and for state `cancelled` (work that is finished or will never happen; either way nothing waits on it) and false for `inProgress` and for an outside blocker that is still open; and the root to a gated milestone depending on every child. Node payloads SHALL carry `title`, `description`, `acceptanceCriteria`, `labels`, `priority`, `url`, and `trackerState`. A label `model:<value>` SHALL set the payload's `model` to `<value>` and a label `effort:<value>` SHALL set `effort` to `<value>`, the prefix matched without regard to case, when the value satisfies the model-selection shape rules; the label SHALL stay in `labels` either way, and a label whose value fails the rule SHALL set nothing and SHALL be listed in the import summary under `ignoredLabels` with its issue id. The milestone SHALL carry the root's `description` and `acceptanceCriteria` when the root record has a description, so that a review shows what the milestone must satisfy. The in-progress rule SHALL be configurable to import such issues as tasks instead.

#### Scenario: Epic with mixed children
- **WHEN** an epic has children A (open), B (open, blocked by A), C (done), and D (open, blocked by X where X is outside the epic)
- **THEN** A and B and D are tasks, B depends on A, C is external with `done: true`, X is external with its done flag from its state, D depends on X, and the epic is a gated milestone depending on A, B, C, and D

#### Scenario: Cancelled child does not hold the milestone
- **WHEN** an epic has children A (open) and K (cancelled)
- **THEN** K is external with `done: true` and `trackerState: cancelled`, and the milestone completes once A is done

#### Scenario: Cancelled blocker does not block
- **WHEN** task B is blocked by K, a child that was cancelled
- **THEN** K is external with `done: true` and B is ready

#### Scenario: In-progress issue is left to its human
- **WHEN** a child is `inProgress` and the in-progress rule is default
- **THEN** it is imported as an external node with `done: false` and nothing is scheduled for it

#### Scenario: Selector labels mapped
- **WHEN** an open child carries the labels `Effort:low` and `model:claude-sonnet-5-5`
- **THEN** its task payload has `effort: "low"` and `model: "claude-sonnet-5-5"` and `labels` still lists both labels

#### Scenario: Unrecognised selector label ignored with a note
- **WHEN** an open child KNO-7 carries the label `effort:huge`
- **THEN** its task payload has no `effort`, `labels` still lists the label, and the import summary's `ignoredLabels` contains `{ id: "KNO-7", label: "effort:huge" }`
