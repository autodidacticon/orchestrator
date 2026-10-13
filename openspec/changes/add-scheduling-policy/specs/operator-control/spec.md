## ADDED Requirements

### Requirement: Status report: deferred candidates
`status` SHALL report `deferred`: the candidates skipped by the scope filter in the most recent admission pass, each as `{ id, reason, with }` where `reason` is `scopeOverlap` and `with` lists the ids whose scopes it overlaps. The event stream digest SHALL carry `deferred` as the count of those candidates. A paused run SHALL report an empty list.

#### Scenario: Deferred candidate explained
- **WHEN** T3 is deferred because its scope overlaps running T2
- **THEN** `status` lists `{ id: T3, reason: scopeOverlap, with: [T2] }` and the digest reports `deferred` 1

#### Scenario: Nothing deferred
- **WHEN** no candidate overlaps a held scope
- **THEN** `deferred` is an empty list and the digest reports 0
