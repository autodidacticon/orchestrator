## Why

The review of CLOUD-M2 v1 (rejected 2026-11-13 at 5c427c4) found two defects in the Postgres deployment:

- The run id was `sha256(real repository path)` cut to 16 characters. The reference manifest runs every daemon with `--repo /data/repo`, so every deployment had the same id. Many runs are meant to share one database, separated by `run_id` and an advisory lock keyed by it. Two deployments of different repositories would either block each other on the lock, or, after a restart, one would load the other's run against its own clone.
- Child environments were built from `process.env`, so check commands and spawned agents received `DATABASE_URL` with its password. A project test suite that follows the `DATABASE_URL` convention would run against the orchestrator's state database, and check output that prints the environment would be stored unscrubbed.

## What Changes

- With `store.kind: postgres` the run id is `store.runId` (file only), else `ORCH_RUN_ID`, else a hash of `git.originUrl`, else (with `git.pushIntegration` on) a hash of the clone's `origin` remote, else the repository path hash with one warning. An explicit id outside 1 to 64 characters of `[A-Za-z0-9_-]` is refused at startup with a message naming it. The run directory follows the run id. SQLite runs are unchanged.
- The base manifest sets no fixed id: the clone's origin (`REPO_URL`) gives each deployment its own. `deploy/README.md` says how the id is chosen and when to set one.
- Every child (check commands, agents of every runner kind) gets an environment without `DATABASE_URL`, `ORCH_RUN_ID`, or any variable whose value is the resolved store URL.
- A `store.url` written in a config file that git tracks is refused at startup, so no worktree carries the URL.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: run id per deployment; no store URL in child environments; no store URL in a tracked config file.
- `cluster-runtime`: the manifest sets no fixed run id, and the README states how the id is chosen.
- `operator-control`: the run directory is named after the run id.
- `agent-protocol`: the agent environment carries no store connection.
- `integration-pipeline`: the check environment carries no store connection.

## Impact

- `src/runs/runDir.ts` (`chooseRunId`, `repoRunId`, `runDirFor`, `trackedInRepo`), `src/config.ts` (`store.runId`), `src/main.ts`, `src/runs/childEnv.ts` (`STORE_VARS`, `withholdStoreUrl`, `withoutStore`), `src/runner/subprocess.ts`.
- `deploy/base/orchestrator.yaml` (comment), `deploy/README.md`.
- Tests: `test/runs/run-id.test.ts`, `test/runs/child-env.test.ts`, `test/runs/deployment-identity.test.ts` (Postgres), `test/host/deploy.test.ts`.
