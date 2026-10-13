# Graph Import Specification

## Purpose
Mapping normalized tracker issue records into a task graph: the normalized record shape and its validation, the rules that map an epic's children and their blocking relations to tasks, external nodes, and a gated milestone, the extraction of acceptance criteria from issue descriptions, and the import outcome returned through the daemon.

## Requirements

### Requirement: Normalized issue record
Import SHALL accept records of the form `{ id, title, description?, state, blockedBy[], parent?, labels?, priority?, url? }` with `state` one of `open`, `inProgress`, `done`, or `cancelled`, plus a `root` id naming the epic or parent. Records SHALL be validated before mapping and a malformed record SHALL fail the import naming the field.

#### Scenario: Malformed record
- **WHEN** a record lacks `state`
- **THEN** the import fails naming that record and `state`, and nothing is written

### Requirement: Mapping rules
The import SHALL map: every child of the root with state `open` to a task whose id is the tracker key; every `blockedBy` edge between two tasks to a dependency; every `blockedBy` target outside the child set, and every child with state `done`, `cancelled`, or `inProgress`, to an `external` node whose `done` flag is true only for state `done`; and the root to a gated milestone depending on every child. Node payloads SHALL carry `title`, `description`, `acceptanceCriteria`, `labels`, `priority`, `url`, and `trackerState`. The in-progress rule SHALL be configurable to import such issues as tasks instead.

#### Scenario: Epic with mixed children
- **WHEN** an epic has children A (open), B (open, blocked by A), C (done), and D (open, blocked by X where X is outside the epic)
- **THEN** A and B and D are tasks, B depends on A, C is external with `done: true`, X is external with its done flag from its state, D depends on X, and the epic is a gated milestone depending on A, B, C, and D

#### Scenario: In-progress issue is left to its human
- **WHEN** a child is `inProgress` and the in-progress rule is default
- **THEN** it is imported as an external node with `done: false` and nothing is scheduled for it

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
