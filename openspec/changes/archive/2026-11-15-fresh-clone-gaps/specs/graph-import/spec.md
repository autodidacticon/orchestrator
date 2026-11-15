## ADDED Requirements

### Requirement: Rejected proposal stays rejected
Under a Postgres store, a stored proposal SHALL be evaluated once per write (its stamp). The reload SHALL record a rejected proposal's stamp and reasons in kv `graph.rejectedStamp`. The store source SHALL NOT evaluate that stamp again, in this daemon or a later one, which still reports it as rejected, so a restart never activates it. A new `PUT /v1/graph` has a new stamp and SHALL be evaluated.

#### Scenario: Compatible later, not activated by a restart
- **WHEN** a proposal is rejected because a task it changes is started, the task later returns to `unstarted`, and the daemon restarts
- **THEN** the active graph is unchanged, no `graph.loaded` event is recorded for the proposal, and the status still reports it as rejected with its reasons

#### Scenario: Sent again
- **WHEN** the same document is sent again after it became compatible
- **THEN** it is evaluated and becomes active

### Requirement: File source re-evaluates a rejected file
With the graph file as the source, a file that differs from the active graph SHALL be evaluated again at every reload. A rejected file therefore becomes active once it is compatible, whether or not the daemon restarted.

#### Scenario: File becomes compatible
- **WHEN** a graph file is rejected because a task it changes is started, and the task later returns to `unstarted`
- **THEN** the next reload makes the file active
