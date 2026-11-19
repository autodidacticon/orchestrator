## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Nine of the 52 requirements of `state-backend` are over the limit: "Durability before effects" (864 characters), "Postgres migrations" (1246), "Postgres schema" (546), "Postgres test database" (1182), "Store selection" (976), "Run id per deployment" (586), "No store URL in child environments" (1804), "Shutdown with unflushed batches" (916) and "Store credentials a child can still reach" (516). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-154).

## What Changes

- MODIFIED "Durability before effects": header and both scenarios kept unchanged; the description is cut to the durability wrapper and the write responses that wait for durability. The fatal-journal behavior moves to one ADDED requirement.
- MODIFIED "Postgres migrations": header and both scenarios kept unchanged; the description is cut to applying the migrations and refusing a database a newer release migrated. The other behaviors move to four ADDED requirements.
- MODIFIED "Postgres schema": header and both scenarios kept unchanged; the launch insertion-order column moves to one ADDED requirement.
- MODIFIED "Postgres test database": header and all five scenarios kept unchanged; the description is cut to where the test run gets its database. The other behaviors move to four ADDED requirements.
- MODIFIED "Store selection": header and all four scenarios kept unchanged; the description is cut to the `store` block and where it is read from. The other behaviors move to two ADDED requirements.
- MODIFIED "Run id per deployment": header and all five scenarios kept unchanged; the shape of an explicit run id moves to one ADDED requirement.
- MODIFIED "No store URL in child environments": header and all six scenarios kept unchanged; the description is cut to the children that never receive `ORCH_RUN_ID` and the scope note. The other behaviors move to five ADDED requirements.
- MODIFIED "Shutdown with unflushed batches": header and all three scenarios kept unchanged; the description is cut to the bounded wait and the report of unflushed batches. The other behaviors move to two ADDED requirements.
- MODIFIED "Store credentials a child can still reach": header and both scenarios kept unchanged; the deployment-notes rule moves to one ADDED requirement.
- Twenty-one ADDED requirements, each with a description of at most 500 characters and scenarios of its own. No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped (65 in the original descriptions, 66 in the cut and ADDED ones: the one sentence over 500 characters was split in two, each part keeping its SHALL NOT).

### Split sentence

- "No store URL in child environments": the sentence "While the daemon withholds (see "Withholding follows the store": always on a Postgres store), they SHALL NOT receive `DATABASE_URL`, `DATABASE_URL_FILE`, any libpq connection variable named in `LIBPQ_VARS` (...), or any variable whose value equals a withheld store URL (the resolved `store.url`)." is 516 characters and has no semicolon of its own. It is split between the items of its list, with its lead-in ("While the daemon withholds (see ...), they SHALL NOT receive") repeated in each part:
  - Part 1, in **Database URL variables withheld from children**: the items `DATABASE_URL`, `DATABASE_URL_FILE` and "any variable whose value equals a withheld store URL (the resolved `store.url`)", unchanged, joined by ", or" where the libpq item stood. "they" is made explicit as the subject of the requirement's first sentence, unchanged but for its lower-case first letter: "check commands, agents of every runner kind together with the processes they start, and the git commands the daemon runs itself through its git wrapper (`src/workspace/git.ts`) together with the project git hooks they trigger".
  - Part 2, in **Libpq variables withheld from children**: the item "any libpq connection variable named in `LIBPQ_VARS` (`src/runs/childEnv.ts`: among them ...)", unchanged. "they" is made explicit as "the children named in "No store URL in child environments"".
- No bullet without a SHALL was given a lead-in: the descriptions have no bullets.

### Moved sentences: "Durability before effects"

- "The orchestrator SHALL wrap the `Workspace`, `AgentRunner` and `VerifierBackend` ... SHALL get the wrapper." stays, unchanged.
- "An optional method the object lacks SHALL stay absent, and a call made with nothing pending SHALL run at once." stays, unchanged.
- "A response to `POST` or `PUT` SHALL be sent only after `store.durable()` resolves, including an error response." stays, unchanged.
- "A fatal journal never becomes durable." moves to **Fatal journal at the durability gate**, unchanged.
- "A wrapped method called on a journal that is already fatal, with or without pending batches, SHALL reject at once with `StoreFatalError` and SHALL NOT run." moves to **Fatal journal at the durability gate**, unchanged.
- "A wrapped method waiting when the journal turns fatal SHALL reject the same way." moves to **Fatal journal at the durability gate**, unchanged.
- "A request gated on durability SHALL answer at once with status 503 and `{ error, code: "storeFatal" }` when the journal is fatal." moves to **Fatal journal at the durability gate**, unchanged.

### Moved sentences: "Postgres migrations"

- "The Postgres sink SHALL apply its SQL migrations at startup, each once, ... serialized across sessions sharing the database." stays, unchanged.
- "The sink SHALL refuse to open when the migrations table records a version that is not among its own migrations, whatever that version is: a newer release has migrated the database." stays, unchanged.
- "The refusal SHALL name the highest recorded version ... it SHALL NOT carry the database password." moves to **Newer schema refusal content**, with "The refusal" made explicit as "The refusal of a database migrated by a newer release".
- "The store open SHALL report the refusal with the code `schemaNewer`." moves to **Newer schema refusal content**, unchanged.
- "The check SHALL run in the migration transaction, ... before the run is loaded." moves to **Newer schema check in the migration transaction**, with "The check" made explicit as "The check for a recorded version the sink does not know".
- "On a refusal the transaction SHALL be rolled back: no migration is applied and no version is recorded." moves to **Newer schema check in the migration transaction**, unchanged.
- "A recorded version the sink knows SHALL NOT be compared by name, and a gap in the recorded versions SHALL NOT be an error." moves to **Recorded migration versions the sink knows**, unchanged.
- "The check runs at startup only: a daemon that is already running ... gets the refusal at its next start." moves to **Newer schema check at startup only**, with "The check" made explicit as "The check for a recorded version the sink does not know".

### Moved sentences: "Postgres schema"

- The first five sentences ("The Postgres tables SHALL mirror ...", "They SHALL be in the store's schema ...", "Documents SHALL be JSONB.", "Every table SHALL have a `run_id` column ...", "`events.seq` and `outbox.id` SHALL be plain `bigint` columns ...") stay, unchanged.
- "`launches` SHALL have an insertion-order column, set when a launch is first inserted and kept on every update and re-applied batch." moves to **Launch insertion order**, unchanged.

### Moved sentences: "Postgres test database"

- "The test run SHALL decide once, in a vitest global setup in the main process, ... otherwise there is no Postgres." stays, unchanged.
- "On the shared cluster each test file SHALL use its own database, dropped when the file ends." moves to **Throwaway Postgres test cluster**, unchanged.
- "The cluster SHALL be stopped and its directory removed when the run ends, ... without its teardown." moves to **Throwaway Postgres test cluster**, with "The cluster" made explicit as "The throwaway cluster".
- "`ORCH_TEST_PG` SHALL accept `auto` (the default), `off` ... and `required` ...; any other value fails the run." moves to **Postgres test mode**, unchanged (181 characters, so not split at its semicolon).
- "A run without Postgres SHALL print exactly one line saying the Postgres suites are skipped and why." moves to **Postgres test mode**, unchanged.
- "Each test SHALL use its own run id." moves to **Postgres test isolation**, unchanged.
- "A test SHALL signal a Postgres server process only when the server is the cluster this run started." moves to **Postgres test isolation**, unchanged.
- "`npm test` SHALL pass, without retries, both with and without Postgres available." moves to **Test suite with and without Postgres**, unchanged.

### Moved sentences: "Store selection"

- "The configuration SHALL carry `store: { kind: sqlite | postgres, url, urlFile, runId, schema, flushDeadlineMs }`, ... (see "Store schema key")." stays, unchanged.
- "The block SHALL be read from the file, the environment and the URL file only." stays, unchanged.
- "When the file leaves `url` unset, `url` SHALL come from the sources of specs/state-backend "Store URL from a file" under `postgres`." moves to **Store URL sources per store kind**, with "the file" made explicit as "the config file".
- "Under `sqlite` the daemon SHALL NOT read `DATABASE_URL` (or `DATABASE_URL_FILE`) as a store input: ... reported with `urlSource: file`." moves to **Store URL sources per store kind**, unchanged.
- "The daemon SHALL open `<dataDir>/store.sqlite` under `sqlite`; under `postgres` it SHALL take the run lock, ... over the Postgres sink." moves to **Store opened per kind**, unchanged (224 characters, so not split at its semicolon).

### Moved sentences: "Run id per deployment"

- "With `store.kind: postgres` the daemon SHALL choose the run id, in this order: ..." stays, unchanged.
- "Origin hashes SHALL leave out the URL's user information." stays, unchanged.
- "`store.runId` SHALL never come from the stored overrides." stays, unchanged.
- "With `store.kind: sqlite` the run id SHALL be as before." stays, unchanged.
- "An explicit id that is not 1 to 64 characters of `[A-Za-z0-9_-]` SHALL fail startup with a message naming it." moves to **Explicit run id shape**, with "An explicit id" made explicit as "With `store.kind: postgres`, an explicit run id (`store.runId` or `ORCH_RUN_ID`)": the id is the explicit id of the Postgres order the sentence followed, and under SQLite it is ignored (scenario "SQLite unchanged").

### Moved sentences: "No store URL in child environments"

- "Check commands, agents of every runner kind ... SHALL NOT receive `ORCH_RUN_ID`, on every store kind." stays, unchanged.
- "This requirement covers environment variables only; what a child running as the daemon's user can still reach is stated in "Store credentials a child can still reach"." stays, unchanged.
- "While the daemon withholds (...), they SHALL NOT receive `DATABASE_URL`, ..." is split in two (see "Split sentence"): part 1 moves to **Database URL variables withheld from children**, part 2 to **Libpq variables withheld from children**.
- "While it withholds, the libpq names SHALL be removed whatever their values, ... loses its own `PG*` variables too." moves to **Libpq names removed whatever their values**, with "it" made explicit as "the daemon".
- "`LIBPQ_VARS` SHALL be the one list of these names." moves to **Libpq names removed whatever their values**, with "these names" made explicit as "the libpq connection variable names".
- "While it does not withhold, these variables SHALL reach the children unchanged." moves to **Database variables when not withholding**, with "it" made explicit as "the daemon" and "these variables" as "`DATABASE_URL`, `DATABASE_URL_FILE`, the `LIBPQ_VARS` names and the variables whose value equals the store URL", and "the children" as "the children named in "No store URL in child environments"".
- "The daemon's own environment SHALL keep them." moves to **Database variables when not withholding**, with "them" made explicit as "the variables it withholds from its children".
- "The environment of each daemon git command SHALL be built when the command runs, ..." moves to **Daemon git command environment**, unchanged.
- "The read-only startup lookups in `src/runs/runDir.ts` (...) run no hooks and are not covered." moves to **Daemon git command environment**, unchanged.

### Moved sentences: "Shutdown with unflushed batches"

- "A shutdown SHALL wait a bounded time for committed batches to reach the sink, ... and SHALL report the committed batches that never reached the sink." stays, unchanged.
- "The sink's own close SHALL NOT be reported as `fenced`." stays, unchanged.
- "When batches are left, the daemon SHALL log their count and exit non-zero." moves to **Shutdown exit status**, with "batches are left" made explicit as "committed batches are left unflushed at a shutdown".
- "This applies after the close and also when the shutdown grace period elapses with batches pending." moves to **Shutdown exit status**, with "This" made explicit as "Logging the count and exiting non-zero".
- "A shutdown with every batch durable SHALL exit 0." moves to **Shutdown exit status**, unchanged.
- "A batch the sink rejects for its content after the flusher stopped SHALL NOT be fatal." moves to **Content rejection after the flusher stopped**, unchanged.
- "It SHALL be logged with its cause (message, SQLSTATE, table and key), and the close SHALL return that cause." moves to **Content rejection after the flusher stopped**, with "It" made explicit as "A batch rejected that way".
- "The close SHALL wait a bounded time for the apply in flight to settle after the sink closes, so the log lands before the daemon exits." moves to **Content rejection after the flusher stopped**, unchanged.
- "Other failures after the flusher stopped are the sink closing and SHALL NOT be logged as rejections." moves to **Content rejection after the flusher stopped**, unchanged.

### Moved sentences: "Store credentials a child can still reach"

- "The daemon removes only environment variables from its children, ...", "Any process of the daemon's user in its container ... where the kernel allows." and "No requirement SHALL claim the daemon prevents these." stay, unchanged.
- "`deploy/README.md` "Store credentials" SHALL state each of them and what a deployment does about it." moves to **Store credentials in the deployment notes**, with "each of them" made explicit as "each way a child can still read the store credentials (the URL file, the daemon's environment as started, and its memory)".

### Where the new scenarios come from

Each new scenario states behavior the code has at the change's base commit (f37e3bf):

- Fatal journal at the durability gate: `test/state/journal.test.ts` ("a gated call waiting when the journal turns fatal rejects and does not run", "a gated call answers at once with StoreFatalError and does not run (N batches pending)").
- Newer schema refusal content: `test/state/pg.test.ts` ("a database migrated by a newer daemon is refused before the run lock"), `src/state/open.ts` (`schemaNewer` with the redacted URL), `src/state/pg/sink.ts` (`NewerSchemaError`).
- Newer schema check in the migration transaction: `test/state/pg.test.ts` ("migrate refuses a recorded version it does not know"), `src/state/pg/sink.ts` (`migrate`).
- Recorded migration versions the sink knows: `src/state/pg/sink.ts` (`migrate` reads only `version` and compares it with the set of its own versions, then applies each of its migrations not recorded), `test/state/pg.test.ts` ("migrate refuses a recorded version it does not know": recorded `[1]` applies nothing, none recorded applies all).
- Newer schema check at startup only: `src/state/pg/sink.ts` (`migrate` is called from `PgSink.open` only), `test/state/pg.test.ts` ("a database migrated by a newer daemon is refused before the run lock": the first sink holds its lock while the version is recorded, and later opens are refused).
- Launch insertion order: `test/state/pg.test.ts` ("two launches with equal created_at inserted in non-alphabetical id order come back from a loaded image in insertion order").
- Throwaway Postgres test cluster: `test/state/pg-db.ts` (`stopTestPostgres` drops the file's database; the cluster stays up), `test/setup/postgres.ts`.
- Postgres test mode: `test/setup/postgres.ts` (`setup`: the mode check and the skip line).
- Postgres test isolation: `test/state/pg-db.ts` (`freshRunId`), `test/state/store-selection.test.ts` and `test/state/pg.test.ts` (`it.skipIf(pgSource !== 'cluster')` on the tests that signal a server).
- Test suite with and without Postgres: `package.json` (`"test": "vitest run"`, no retries), `test/setup/postgres.ts`.
- Store URL sources per store kind: `test/state/store-selection.test.ts` ("defaults to sqlite with a 120s flush deadline; DATABASE_URL fills an unset url under postgres only and never overrides the file").
- Store opened per kind: `test/state/store-selection.test.ts` ("sqlite opens <dataDir>/store.sqlite", "takes the run lock, loads the image, and a second open of the run is refused with a clear error").
- Explicit run id shape: `src/runs/runDir.ts` (`RUN_ID_PATTERN` and the `invalid run id` message), `test/runs/deployment-identity.test.ts` ("an invalid ORCH_RUN_ID or store.runId fails startup with a message naming it").
- Database URL variables withheld from children: `test/runs/child-env.test.ts` ("childEnv and withoutStore drop DATABASE_URL, ORCH_RUN_ID and every variable whose value is the withheld URL").
- Libpq variables withheld from children: `test/runs/child-env.test.ts` ("LIBPQ_VARS holds exactly the libpq names listed in this file, and each one is dropped by withoutStore, childEnv and isolationEnv").
- Libpq names removed whatever their values: the same test (no URL withheld; `PGDATA`, `PG_HOST`, `MY_PGHOST` kept).
- Database variables when not withholding: `test/runs/child-env.test.ts` ("with withholding off, withoutStore and childEnv keep the database variables and drop ORCH_RUN_ID ...").
- Daemon git command environment: `test/slice/git-env.test.ts` ("a pre-commit hook run by a daemon git commit, and the plain and bounded git paths, see no store URL").
- Shutdown exit status: `src/main.ts` (`exitLosing` on the grace timer and after the close; exit record via `recordExit`), `test/runs/lifecycle.test.ts` ("a close with nothing unflushed adds nothing, and the record is clean").
- Content rejection after the flusher stopped: `test/state/journal.test.ts` ("a sink failing after abandon for a reason other than its content is not logged as a rejection").
- Store credentials in the deployment notes: `deploy/README.md` ("Store credentials": "What the daemon cannot remove" and the measures listed after it).

## Capabilities

### New Capabilities

### Modified Capabilities

- `state-backend`: nine long requirements cut to one behavior each; twenty-one requirements added for the moved behaviors.

## Impact

Spec text only. No code, test or other capability changes.
