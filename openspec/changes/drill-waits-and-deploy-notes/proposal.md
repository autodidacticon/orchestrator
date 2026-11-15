## Why

The review of CLOUD-M2 v2 (2026-11-14) read the cluster drill and the deployment notes (ORC-101). Not blocking, but:

- `deploy/README.md` still said the daemon's own git commands inherit its environment, so a project hook could see `DATABASE_URL`. ORC-95 (`git-env-no-store-url`) removed the store URL from those commands.
- The Postgres-restart drill slept `SETTLE_S` seconds after `/readyz` passed and then compared once. `/readyz` passes before startup recovery runs, so a daemon still recovering passed or failed by timing. A container restart keeps the pod's `emptyDir`, so the parked worktrees survive and recovery leaves no event that could be waited on.
- "The daemon exited when its session was lost" read the restart count only. A container that restarted for another reason (an out-of-memory kill, a failed probe) passed it. Reading `kubectl logs --previous` or `lastState` after the fact is not enough either: the daemon crash-loops until Postgres is back, so both may already describe a later start that could not connect (seen on kind: `lastState` of a one-second start ending in `ECONNREFUSED`).
- `originIdentity` removes only user information from an origin URL, so `https://host/x.git`, `https://host/x` and `https://host/x/` are three run ids. Changing the rule would change the run id of existing deployments, so it is documented, not changed.
- Some skipped steps printed nothing: under `--dry-run` each assertion printed its command only.

## What Changes

- **Deployment notes.** `deploy/README.md` says the daemon's git commands do not carry the store URL. Under "The run id" it says the id follows the origin URL as written apart from user information, lists spellings that differ and spellings that do not, and names `store.runId` and `ORCH_RUN_ID` as the way to pin it.
- **A condition, not a sleep.** Before deleting the Postgres pod the drill records `latestSeq` and removes `.orchestrator/brief.json` from each claimable launch's worktree in the pod. Startup recovery then prepares each again and records `launch.reprepared`. After `/readyz` passes, the drill waits (bounded by `STATUS_TIMEOUT_S`) until each recorded claimable launch has one, asserts exactly one each, and only then compares. `SETTLE_S` is removed.
- **Why the daemon restarted.** The drill follows the daemon container's log into a file from before the deletion; the follower ends when that container exits. It asserts that the container's last termination, read when the restart is first seen, is exit code 1 with reason `Error`, and that the exited container's last log line is `store fatal: exiting` with `reason: fenced`.
- **`--break restart`.** Sends SIGTERM to the daemon in place of deleting the Postgres pod. The daemon exits 0 and its container restarts, so the restart count rises and the reason assertion fails.
- **Skip lines.** A check or step that does not run prints `smoke: skip: <name> (<why>)`: every assertion under `--dry-run`, the worker step on a kept cluster, and the Postgres pod deletion under `--break restart`. The script reads no `TEST_DATABASE_URL`.

## Capabilities

### Modified Capabilities
- `cluster-runtime`: "Smoke test" (the `--break` values), "Smoke worker step" (the skip line), "Smoke assertions are named" (skip lines), "Smoke test options" (`--break restart`), "Deployment run id" (spellings and pinning), and "Smoke Postgres-restart drill" (recovery witness, restart reason, no fixed sleep).

## Impact

- `deploy/smoke.sh`, `deploy/README.md`.
- No source change. `test/host/smoke.test.ts` passes unchanged: the dry-run step order it checks is kept.
