## MODIFIED Requirements

### Requirement: Store transactions
The store's `transaction(fn)` SHALL run `fn` inside one SQLite transaction that commits when `fn` returns, returning its value, and that is rolled back entirely when `fn` throws, rethrowing the error. A `transaction` call made while a transaction is open SHALL nest as a savepoint: when the inner function throws, only the inner function's writes are undone and the outer transaction continues; when the outer function throws, the inner function's writes are undone with it. A primary key or unique violation SHALL throw an `Error` whose message names the constraint, and the transaction it happened in SHALL roll back. The store SHALL open in WAL mode with `synchronous = NORMAL` and a busy timeout of five seconds, so that a reader in another process never blocks the writer and a writer that finds the database locked by another connection waits for it rather than failing at once. The busy timeout SHALL be set before the switch to WAL mode, and opening the store SHALL retry the WAL switch and the schema creation while SQLite reports `SQLITE_BUSY`, for up to the same five seconds, because SQLite returns `SQLITE_BUSY` from the switch without calling the busy handler when two connections open a new file at once. An existing store file SHALL open unchanged.

#### Scenario: Inner rollback, outer commit
- **WHEN** an outer transaction writes entry T1, calls an inner `transaction` that writes entry T2 and throws, catches the error, and returns
- **THEN** T1 is present and T2 is absent after the outer transaction

#### Scenario: Outer rollback undoes the inner
- **WHEN** an outer transaction calls an inner `transaction` that writes entry T3 and returns, and then throws
- **THEN** T3 is absent after the error

#### Scenario: Duplicate launch rolls back
- **WHEN** a transaction appends an event and then creates a launch whose `launchId` exists
- **THEN** the call throws an error whose message contains `UNIQUE constraint failed` and the event is absent

#### Scenario: Second process waits for the writer
- **WHEN** another process holds a write transaction open on the store and this process writes a key
- **THEN** a read of that key made while the other transaction is open returns the previous value, and the write succeeds after the other process commits, having waited rather than thrown

#### Scenario: Opening a store another process is creating
- **WHEN** another process has created the store file, still in rollback-journal mode, and holds its exclusive lock for one second while this process opens the store
- **THEN** the open waits for the lock and succeeds, rather than throwing "database is locked"; a daemon starting in that moment keeps running instead of exiting at startup

#### Scenario: Existing file reopens
- **WHEN** a store is closed and opened again from its file
- **THEN** its entries, events, keys, and snapshot read back unchanged
