## MODIFIED Requirements

### Requirement: Tracker record
`import_issues` SHALL accept an optional `tracker` of `{ kind: linear | atlassian | github, workspace?, inProgressLabel? }` and SHALL pass it to the daemon's `import` route with the mapped graph. For `github`, `workspace` SHALL be the repository as `owner/repo`, and `inProgressLabel` MAY name the label that stands for the in-progress state; the field SHALL be refused for other kinds. When present, the route SHALL record the tracker in the store under the key `tracker` and SHALL append a `tracker.recorded` event; when absent, a previously recorded tracker SHALL remain in force. The mapping SHALL be unchanged by `tracker`. `status` and the outbox policy SHALL report the recorded tracker including `inProgressLabel`.

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
