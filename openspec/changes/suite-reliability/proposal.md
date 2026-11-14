## Why

The review of CLOUD-M2 v1 (ORC-94) measured the suite without `--retry`: one of six runs at 5c427c4 and two of four at a0dd18b failed, on timeouts in the crash suite (one hidden behind an `ENOTEMPTY` while removing the temp directory) and in the work-loop silence test. The check command's `--retry 2` hid them. Also:

- The Postgres suites skipped silently when no Postgres was found, and nothing could require them.
- Each of four Postgres test files started its own cluster lazily inside a 30-second hook, and a killed fork left its postmaster and directory behind.
- `store-selection.test.ts` sent SIGSTOP to a backend pid on the local machine even when the server came from `TEST_DATABASE_URL`.
- The randomized journal test never wrote `verifier_jobs`, `proposals` or `payload_overlays`.

## What Changes

- A vitest global setup (`test/setup/postgres.ts`) decides once per run where Postgres comes from and starts at most one throwaway cluster, in the main process, shared by every test file (each file in its own database). Teardown stops it, and a watchdog stops it if the main process dies.
- `ORCH_TEST_PG=required` fails the run without Postgres, and an unknown value fails the run. A run without Postgres prints one line saying the Postgres suites are skipped and why. A `TEST_DATABASE_URL` that does not connect fails the run.
- Tests signal only processes they started: the backend SIGSTOP needs the run's own cluster, and the work-loop cleanup checks a recorded pid's command line before killing it.
- The randomized journal test writes every journaled table and asserts that it did.
- The crash harness waits for its processes before removing its directory. The hung-agent work-loop tests get a timeout that covers their inner waits.
- Races found by running two full suites at once are fixed in the tests: a stray worktree planted before the real one was removed, a cascade crash point that fired before the reopen arrived, a terminal state read before the worktree removal and the milestone tag landed, and a slice directory removed under a reaped agent.
- Remaining, cause in `src/`: `crash at launch.afterSpawn then restart converges` occasionally keeps one worktree, because the worktree removal on publish is not awaited, swallows errors and is never retried. It is named in tasks.md and left for a follow-up.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: "Postgres test database" (shared cluster, `ORCH_TEST_PG` modes, the skip line, signal rule) is modified, and "Randomized journal test covers every table" is added.

## Impact

- Tests only: `vitest.config.ts`, `test/setup/postgres.ts`, `test/state/pg-db.ts`, `test/state/journal.test.ts`, `test/state/store-selection.test.ts`, `test/runs/deployment-identity.test.ts`, `test/host/work-loop.test.ts`, `test/crash/harness.ts` and its callers.
- "Postgres test database" is added by the unarchived `postgres-journal-sink` change. Archive that change first.
