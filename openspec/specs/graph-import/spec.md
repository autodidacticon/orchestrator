# Graph Import Specification

## Purpose
Mapping normalized tracker issue records into a task graph: the normalized record shape and its validation, the rules that map an epic's children and their blocking relations to tasks, external nodes, and a gated milestone, the extraction of acceptance criteria from issue descriptions, the import outcome returned through the daemon, and the recording of the source tracker at import so that a run can be mirrored back to it.

## Requirements

### Requirement: Normalized issue record
Import SHALL accept records of the form `{ id, title, description?, state, blockedBy[], parent?, labels?, priority?, url? }` with `state` one of `open`, `inProgress`, `done`, or `cancelled`, plus a `root` id naming the epic or parent. Records SHALL be validated before mapping and a malformed record SHALL fail the import naming the field.

#### Scenario: Malformed record
- **WHEN** a record lacks `state`
- **THEN** the import fails naming that record and `state`, and nothing is written

### Requirement: Mapping rules
The import SHALL map: every child of the root with state `open` to a task whose id is the tracker key; every `blockedBy` edge between two tasks to a dependency; every `blockedBy` target outside the child set, and every child with state `done`, `cancelled`, or `inProgress`, to an `external` node whose `done` flag is true only for state `done`; and the root to a gated milestone depending on every child. Node payloads SHALL carry `title`, `description`, `acceptanceCriteria`, `labels`, `priority`, `url`, and `trackerState`. A label `model:<value>` SHALL set the payload's `model` to `<value>` and a label `effort:<value>` SHALL set `effort` to `<value>`, the prefix matched without regard to case, when the value satisfies the model-selection shape rules; the label SHALL stay in `labels` either way, and a label whose value fails the rule SHALL set nothing and SHALL be listed in the import summary under `ignoredLabels` with its issue id. The milestone SHALL carry the root's `description` and `acceptanceCriteria` when the root record has a description, so that a review shows what the milestone must satisfy. The in-progress rule SHALL be configurable to import such issues as tasks instead.

#### Scenario: Epic with mixed children
- **WHEN** an epic has children A (open), B (open, blocked by A), C (done), and D (open, blocked by X where X is outside the epic)
- **THEN** A and B and D are tasks, B depends on A, C is external with `done: true`, X is external with its done flag from its state, D depends on X, and the epic is a gated milestone depending on A, B, C, and D

#### Scenario: In-progress issue is left to its human
- **WHEN** a child is `inProgress` and the in-progress rule is default
- **THEN** it is imported as an external node with `done: false` and nothing is scheduled for it

#### Scenario: Selector labels mapped
- **WHEN** an open child carries the labels `Effort:low` and `model:claude-sonnet-5-5`
- **THEN** its task payload has `effort: "low"` and `model: "claude-sonnet-5-5"` and `labels` still lists both labels

#### Scenario: Unrecognised selector label ignored with a note
- **WHEN** an open child KNO-7 carries the label `effort:huge`
- **THEN** its task payload has no `effort`, `labels` still lists the label, and the import summary's `ignoredLabels` contains `{ id: "KNO-7", label: "effort:huge" }`

### Requirement: Acceptance criteria from the description
The import SHALL split a description at the first heading matching the configured text, default "Acceptance criteria", case-insensitively. Bullet, numbered, and checklist items under that heading up to the next heading SHALL become the `acceptanceCriteria` array; the text before the heading SHALL become `description`. A description without the heading SHALL yield no criteria, and the import summary SHALL name such tasks as ones that will block at ready.

#### Scenario: Criteria parsed
- **WHEN** a description reads "Do the thing.\n\n## Acceptance criteria\n- [ ] it works\n- documented\n\n## Notes\nignore"
- **THEN** `description` is "Do the thing." and `acceptanceCriteria` is ["it works", "documented"]

#### Scenario: Missing heading reported
- **WHEN** a child has no acceptance-criteria heading
- **THEN** the import succeeds and the summary lists that id under tasks missing criteria

### Requirement: Import outcome
The import SHALL validate the mapped graph with the graph loader, write it through the daemon's `import` route, and return the revision, the reload classification with reasons, counts of tasks, external nodes, and milestones, and the ids missing acceptance criteria. Re-importing the same root SHALL produce a reload that the daemon classifies under the compatibility rules.

#### Scenario: Re-import after a tracker change
- **WHEN** an epic is re-imported after an external blocker was closed in the tracker
- **THEN** the external node's `done` flag becomes true, the reload is compatible, and dependents become ready

### Requirement: Tracker record
`import_issues` SHALL accept an optional `tracker` of `{ kind: linear | atlassian, workspace? }` and SHALL pass it to the daemon's `import` route with the mapped graph. When present, the route SHALL record it in the store under the key `tracker` and SHALL append a `tracker.recorded` event; when absent, a previously recorded tracker SHALL remain in force. The mapping SHALL be unchanged by `tracker`. `status` SHALL report the recorded tracker.

#### Scenario: Tracker recorded at import
- **WHEN** `import_issues` is called with `tracker: { kind: linear, workspace: acme }`
- **THEN** the store holds `tracker` with that kind and workspace, a `tracker.recorded` event is appended, and `status` reports it

#### Scenario: Re-import keeps the record
- **WHEN** the same root is re-imported without `tracker`
- **THEN** the recorded tracker is unchanged

#### Scenario: File import records nothing
- **WHEN** a hand-written graph is imported through `import_graph` in a run with no tracker recorded
- **THEN** no tracker is recorded and `status` reports none

### Requirement: Priority normalisation
The import SHALL pass a record's `priority` into the task payload unchanged, except that a numeric priority of 0, which Linear uses for no priority, SHALL be omitted so that the task sorts as having no priority.

#### Scenario: Linear no-priority omitted
- **WHEN** a child record has `priority: 0`
- **THEN** the mapped task payload has no `priority`

#### Scenario: Other priorities pass through
- **WHEN** two child records have `priority: 1` and `priority: 4`
- **THEN** the mapped payloads carry `priority` 1 and 4 unchanged

### Requirement: Scope from the description
The import SHALL split a description at the first heading matching the configured scope heading, default "Scope", case-insensitively, with the same splitter as acceptance criteria. Each bullet, numbered, or checklist item under that heading up to the next heading SHALL become one glob in the task's `scope`. `description` SHALL be the text before the first of the criteria and scope headings, in whichever order they appear. A description without the scope heading SHALL yield no `scope`.

#### Scenario: Scope parsed
- **WHEN** a description reads "Do the thing.\n\n## Acceptance criteria\n- it works\n\n## Scope\n- src/api/**\n- package.json"
- **THEN** `description` is "Do the thing.", `acceptanceCriteria` is ["it works"], and `scope` is ["src/api/**", "package.json"]

#### Scenario: Headings in either order
- **WHEN** the scope heading precedes the criteria heading
- **THEN** `description` is the text before the scope heading and both lists are parsed

#### Scenario: No scope heading
- **WHEN** a child's description has no scope heading
- **THEN** the mapped task has no `scope` and the import succeeds
