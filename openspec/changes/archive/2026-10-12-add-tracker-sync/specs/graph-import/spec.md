## ADDED Requirements

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
