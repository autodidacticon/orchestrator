## ADDED Requirements

### Requirement: Empty run beside tables in another schema

Under `store.kind: postgres`, when the load finds no row for the run id in the configured schema, the daemon SHALL look, with one catalogue query on the sink's session, for other schemas of the database holding an ordinary table named `orchestrator_migrations`. When it finds any, it SHALL log one warning and append one `config.warning` event with `code: 'tablesInOtherSchema'`. A failed query SHALL NOT stop the start.

#### Scenario: An empty run with tables in another schema

- **WHEN** a daemon starts a run that has no row in the configured schema while another schema of the database holds an ordinary table named `orchestrator_migrations`
- **THEN** it finds that schema with one query on `pg_catalog.pg_class` joined with `pg_catalog.pg_namespace`, leaving out the configured schema and reading no row of another schema
- **AND** it logs one warning naming every such schema, sorted, the configured schema, the run id and the key `store.schema`
- **AND** it appends one `config.warning` event with `code` `tablesInOtherSchema`, the message, and the schema names in `schemas`
- **AND** the warning does not say whether the other schema holds rows for this run id, and does not name other run ids

#### Scenario: A run that has rows

- **WHEN** the load finds at least one row for the run id, as at every start after the first (each start writes the run id and a `config.resolved` event)
- **THEN** the daemon runs no catalogue query and logs no such warning

#### Scenario: No other schema

- **WHEN** a run is empty and no other schema of the database holds a table named `orchestrator_migrations` (a schema holding only other store table names, such as `launches`, does not count)
- **THEN** the daemon logs no such warning and appends no such event

#### Scenario: A failed catalogue query

- **WHEN** the catalogue query fails
- **THEN** the daemon logs nothing about it, appends no event, and starts as it would without the check
