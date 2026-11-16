## ADDED Requirements

### Requirement: Storable ids
An id that holds a NUL character or a lone UTF-16 surrogate SHALL be refused at its entry point, before anything is written. The entry points are graph load (each node `id` and `deps` entry), `POST /v1/claims` (`workerId`, `taskId`, `attachment`) and `POST /v1/attachments` (`id`). Every id that passes SHALL be stored unchanged. The rewrite of "Storable strings" stays as the store's backstop.

#### Scenario: Ids that pass are found again
- **WHEN** task, launch, job, proposal, attachment, kv and worker ids holding non-ASCII text, a surrogate pair or U+FFFD are written to every key column of each backend
- **THEN** each row is found by the same id before and after a reopen, and a worker that claimed with such an id finds its launch on its next claim

#### Scenario: Refused before the store
- **WHEN** an id that "Storable strings" would change arrives at one of the entry points
- **THEN** it is refused there and no row is written under it or under its rewritten form

### Requirement: Refused graph id
A graph whose node id or dependency holds a NUL or a lone surrogate SHALL fail validation with code `unstorableId`. The message SHALL name the field (`nodes.<i>.id` or `nodes.<i>.deps.<j>`) and the id written as a JSON string. The details SHALL be `{ field, id }`.

#### Scenario: Graph node with a NUL in its id
- **WHEN** a graph file has a node whose id is `T\u0000x`
- **THEN** loading it fails with code `unstorableId`, the message names `nodes.<i>.id` and the id with the NUL escaped, and no graph is loaded

#### Scenario: Dependency with a lone surrogate
- **WHEN** a graph node lists a dependency `T\uD83D`, a lone high surrogate
- **THEN** loading it fails with code `unstorableId` naming `nodes.<i>.deps.<j>`

### Requirement: Refused request id
A claim or attachment request with an id that holds a NUL or a lone surrogate SHALL be answered 400. The `field` SHALL name the request field and the error SHALL name the id written as a JSON string. The request SHALL append no event and change no row.

#### Scenario: Claim with an unstorable worker id
- **WHEN** a worker posts `/v1/claims` with a `workerId`, `taskId` or `attachment` that holds a NUL or a lone surrogate
- **THEN** the daemon answers 400 with `field` set to that request field, no event is appended, and no launch is claimed

#### Scenario: Attachment with an unstorable id
- **WHEN** a session posts `/v1/attachments` with an `id` that holds a NUL or a lone surrogate
- **THEN** the daemon answers 400 with `field` `id`, and no attachment is stored
