## ADDED Requirements

### Requirement: Graph source by store kind
Under `store.kind: sqlite` the graph source SHALL be the run's graph file, unchanged. Under `store.kind: postgres` it SHALL be the store's proposed-graph slot: `PUT /v1/graph` SHALL write the slot and reload at once, and proposal acceptance SHALL read the slot, falling back to the active graph when it is empty. No graph file is read or written.

#### Scenario: Import on a Postgres run
- **WHEN** `PUT /v1/graph` is called on a Postgres run
- **THEN** the document is written to the proposed slot, the reload accepts it, and no graph file exists

### Requirement: Proposed graph slot
The store SHALL keep the proposed graph apart from the accepted snapshot. The snapshot SHALL be written only after a reload passes classification and SHALL be trusted without classification at startup. A document SHALL be evaluated once per write, so an unchanged rejected one is not classified again every tick and a re-sent one is.

#### Scenario: Rejected graph across a restart
- **WHEN** an incompatible graph is sent with `PUT /v1/graph` and the daemon is restarted
- **THEN** the response reports it rejected with reasons, it stays in the proposed slot, and after the restart the active graph is still the previously accepted one
