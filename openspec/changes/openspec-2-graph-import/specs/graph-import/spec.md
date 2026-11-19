## MODIFIED Requirements

### Requirement: Mapping rules
The import SHALL map: every child of the root with state `open` to a task whose id is the tracker key; every `blockedBy` edge between two tasks to a dependency; and the root to a gated milestone depending on every child.

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

#### Scenario: Runner label mapped
- **WHEN** an open child carries the label `Runner:codex`
- **THEN** its task payload has `runner: "codex"` and `labels` still lists the label

#### Scenario: Unrecognised selector label ignored with a note
- **WHEN** an open child KNO-7 carries the label `effort:huge`
- **THEN** its task payload has no `effort`, `labels` still lists the label, and the import summary's `ignoredLabels` contains `{ id: "KNO-7", label: "effort:huge" }`

#### Scenario: Unknown runner kind ignored with a note
- **WHEN** an open child KNO-8 carries the label `runner:bogus`
- **THEN** its task payload has no `runner`, `labels` still lists the label, and the import summary's `ignoredLabels` contains `{ id: "KNO-8", label: "runner:bogus" }`

### Requirement: Tracker record
`import_issues` SHALL accept an optional `tracker` of `{ kind: linear | atlassian | github, workspace?, inProgressLabel? }` and SHALL pass it to the daemon's `import` route with the mapped graph. The mapping SHALL be unchanged by `tracker`.

#### Scenario: Tracker recorded at import
- **WHEN** `import_issues` is called with `tracker: { kind: linear, workspace: acme }`
- **THEN** the store holds `tracker` with that kind and workspace, a `tracker.recorded` event is appended, and `status` reports it

#### Scenario: GitHub tracker with a label
- **WHEN** `import_issues` is called with `tracker: { kind: github, workspace: "autodidacticon/kya", inProgressLabel: "in-progress" }`
- **THEN** the store holds the tracker with all three fields, the mapped graph is identical to an import without `tracker`, and the outbox policy reports the label to drainers

#### Scenario: Label refused for other trackers
- **WHEN** `import_issues` is called with `tracker: { kind: linear, inProgressLabel: "x" }`
- **THEN** the import fails naming `inProgressLabel` and nothing is written

#### Scenario: Re-import keeps the record
- **WHEN** the same root is re-imported without `tracker`
- **THEN** the recorded tracker is unchanged

#### Scenario: File import records nothing
- **WHEN** a hand-written graph is imported through `import_graph` in a run with no tracker recorded
- **THEN** no tracker is recorded and `status` reports none

## ADDED Requirements

### Requirement: External nodes from the import
The import SHALL map every `blockedBy` target outside the child set, and every child with state `done`, `cancelled`, or `inProgress`, to an `external` node whose `done` flag is true for state `done` and for state `cancelled` (work that is finished or will never happen; either way nothing waits on it) and false for `inProgress` and for an outside blocker that is still open.

#### Scenario: Open outside blocker
- **WHEN** an open child ENG-5 is blocked by OPS-7, an open issue outside the epic
- **THEN** OPS-7 is an `external` node with `done: false` and ENG-5 depends on it

### Requirement: Node payload fields
Node payloads SHALL carry `title`, `description`, `acceptanceCriteria`, `labels`, `priority`, `url`, and `trackerState`.

#### Scenario: Payload of an open child
- **WHEN** an open child ENG-5 has the label `backend`, `priority: 2`, and `url: https://x/ENG-5`
- **THEN** its task payload has `labels: ["backend"]`, `priority: 2`, `url: "https://x/ENG-5"`, and `trackerState: open`

### Requirement: Selector labels set payload keys
A label `model:<value>` SHALL set the payload's `model` to `<value>`, a label `effort:<value>` SHALL set `effort` to `<value>`, and a label `runner:<value>` SHALL set `runner` to `<value>`, the prefix matched without regard to case, when the value satisfies the model-selection shape rules (for `runner`, one of the runner kinds).

#### Scenario: Effort label with any known effort
- **WHEN** an open child carries the label `effort:ultra`
- **THEN** its task payload has `effort: "ultra"`

### Requirement: Selector labels kept and failures listed
A `model:`, `effort:` or `runner:` label SHALL stay in `labels` whether or not its value satisfies the model-selection shape rules, and a label whose value fails those rules SHALL set nothing and SHALL be listed in the import summary under `ignoredLabels` with its issue id.

#### Scenario: Two failing labels on one issue
- **WHEN** an open child KNO-7 carries the labels `effort:huge` and `MODEL: opus; rm`
- **THEN** its task payload has neither `effort` nor `model`, `labels` still lists both labels, and the import summary's `ignoredLabels` is `[{ id: "KNO-7", label: "effort:huge" }, { id: "KNO-7", label: "MODEL: opus; rm" }]`

### Requirement: Milestone carries the root's criteria
The milestone SHALL carry the root's `description` and `acceptanceCriteria` when the root record has a description, so that a review shows what the milestone must satisfy.

#### Scenario: Root criteria on the milestone
- **WHEN** the root's description reads "The goal.\n\n## Acceptance criteria\n- demo runs\n- docs updated"
- **THEN** the milestone has `description` "The goal." and `acceptanceCriteria` ["demo runs", "docs updated"]

#### Scenario: Root without a description
- **WHEN** the root record has no description
- **THEN** the milestone has no `description`

### Requirement: Configurable in-progress rule
The in-progress rule SHALL be configurable to import issues with state `inProgress` as tasks instead.

#### Scenario: In-progress issue imported as a task
- **WHEN** a child ENG-6 is `inProgress` and the import's `inProgress` option is `task`
- **THEN** ENG-6 is a task and the import summary's `inProgressAsExternal` is empty

### Requirement: GitHub tracker fields
For `github`, `workspace` SHALL be the repository as `owner/repo`, and `inProgressLabel` MAY name the label that stands for the in-progress state; the `inProgressLabel` field SHALL be refused for other kinds.

#### Scenario: Label refused by the import route
- **WHEN** `PUT /v1/graph` is called with `tracker: { kind: linear, inProgressLabel: "x" }`
- **THEN** the response is 400 and no `tracker.recorded` event is appended

### Requirement: Tracker stored at import
When `tracker` is present, the `import` route SHALL record the tracker in the store under the key `tracker` and SHALL append a `tracker.recorded` event; when `tracker` is absent, a previously recorded tracker SHALL remain in force.

#### Scenario: Recorded once, kept by a later import
- **WHEN** `PUT /v1/graph` is called with `tracker: { kind: linear, workspace: acme }` and then again without `tracker`
- **THEN** `status` reports the tracker with kind `linear` and workspace `acme` after both calls, and exactly one `tracker.recorded` event is appended

#### Scenario: Invalid tracker records nothing
- **WHEN** `PUT /v1/graph` is called with `tracker: { kind: jira }`
- **THEN** the response is 400, the recorded tracker is unchanged, and no `tracker.recorded` event is appended

### Requirement: Tracker reported to drainers
`status` and the outbox policy SHALL report the recorded tracker including `inProgressLabel`.

#### Scenario: In-progress label in status and outbox policy
- **WHEN** `PUT /v1/graph` records `tracker: { kind: github, workspace: "acme/app", inProgressLabel: "in-progress" }`
- **THEN** `GET /v1/status` reports `tracker` with all three fields and `GET /v1/outbox` reports `policy.tracker` with kind `github` and `inProgressLabel` `in-progress`
