## ADDED Requirements

### Requirement: Postgres store without push integration
With `store.kind: postgres` and `git.pushIntegration` off, the daemon SHALL start and SHALL warn in the log and in a `config.warning` event with code `postgresWithoutPushIntegration`, naming `git.pushIntegration: true` as the remedy. The integration branch then lives only in the clone, so a restart without a volume loses publications the store records `done`. The daemon cannot tell a volume from an emptyDir, so it warns rather than refuses.

#### Scenario: Postgres without push integration
- **WHEN** a daemon starts with `store.kind: postgres` and `git.pushIntegration: false`
- **THEN** it starts, logs the warning, and records one `config.warning` event with code `postgresWithoutPushIntegration`

#### Scenario: Postgres with push integration
- **WHEN** a daemon starts with `store.kind: postgres` and `git.pushIntegration: true`
- **THEN** no durability warning is given
