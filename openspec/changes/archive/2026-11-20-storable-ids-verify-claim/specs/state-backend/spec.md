## MODIFIED Requirements

### Requirement: Storable ids
An id that holds a NUL character or a lone UTF-16 surrogate SHALL be refused at its entry point, before anything is written. The entry points are graph load (each node `id` and `deps` entry), `POST /v1/claims` (`workerId`, `taskId`, `attachment`), `POST /v1/attachments` (`id`) and `POST /v1/verify/claims` (`verifierId`). Every id that passes SHALL be stored unchanged. The rewrite of "Storable strings" stays as the store's backstop.

#### Scenario: Ids that pass are found again
- **WHEN** task, launch, job, proposal, attachment, kv and worker ids holding non-ASCII text, a surrogate pair or U+FFFD are written to every key column of each backend
- **THEN** each row is found by the same id before and after a reopen, and a worker that claimed with such an id finds its launch on its next claim

#### Scenario: Refused before the store
- **WHEN** an id that "Storable strings" would change arrives at one of the entry points
- **THEN** it is refused there and no row is written under it or under its rewritten form
