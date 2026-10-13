## ADDED Requirements

### Requirement: Reopen tool cascade parameter
The `reopen` tool SHALL accept an optional boolean `cascade`, forward it in the route body, and return the route's response unchanged, so that a refusal carries `blockers` and a cascade carries `reset`.

#### Scenario: Refusal then cascade
- **WHEN** `reopen` is called for T1 while T2 runs, and then called again with `cascade: true`
- **THEN** the first result carries `blockers` with T2 and the second carries `reset` with T1 and T2

### Requirement: Proposal tools
The server SHALL expose `proposals` with an optional `status`, `accept_proposal` with `id`, optional `nodeId`, and optional `payload`, and `reject_proposal` with `id` and `note`, each forwarding to the corresponding daemon route and returning a single JSON text block.

#### Scenario: Accept through the tool
- **WHEN** `accept_proposal` is called with `T2-p1` and `nodeId` ENG-77
- **THEN** the daemon records the operator event, the result reports node ENG-77, and `status` no longer lists `T2-p1`
