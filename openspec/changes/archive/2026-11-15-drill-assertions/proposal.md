## Why

The review of CLOUD-M2 v1 (2026-11-13) ran `deploy/smoke.sh --fresh` and read it. Several assertions were weaker than their names:

- The claimable checks compared task ids. `--break claimable` ends the claimed launch and parks a new one for the same task, so "claimable set unchanged" passed and only "launches by status unchanged" failed. A restart that replaced every parked launch with a new id and token would pass.
- "No orchestrator volume claim" was a name match on `kubectl get pvc`. A claim named `data` mounted by the daemon would pass.
- The outage drill never showed the write was pending, and "`/readyz` failed" accepted any non-200, including curl's `000`.
- The reprepared events were read once, while `/readyz` passes before startup recovery runs (the API listens before `Orchestrator.start`).
- The restart drill never checked that the pod was new.
- The outage drill is a stall on an open session. No drill took Postgres away, which the daemon handles by exiting and coming back.
- `--fresh` changed the current kubectl context while the README and spec said the script never does, and `KUBE_CONTEXT` could name a different cluster from `KIND_CLUSTER`. The main spec still says any argument other than `--dry-run` exits 2.

## What Changes

- **Claimable launches by id.** The API side reads launch ids from the launch events and checks their tasks against `/v1/status`; the `psql` side records launch id, task id and the md5 of the token. `--break claimable` now fails `drill: claimable set unchanged (API)`. After every drill, a claim of `SMOKE-PARKED` must return the launch id and token recorded before the first restart; the launch is released again.
- **Volumes, not names.** `daemon_mounts_no_claim` inspects the daemon pod's volumes and fails on any `persistentVolumeClaim` or `ephemeral` volume. `--break pvc` mounts a claim named `data-smoke-break` into the daemon (a Deployment patch, removed on exit) before the snapshot.
- **Restart drill.** Asserts a new pod uid, and waits until startup recovery has an event for every recorded claimable launch before comparing anything.
- **Outage drill.** Before the thaw, the write's request must still be running with no answer and `storePendingBatches` above zero. `/readyz` must answer 503 at least once and only 200 or 503.
- **Postgres-restart drill.** Deletes the Postgres pod, asserts the daemon container restarts, then that the daemon is Ready with `/readyz` 200 within `PG_READY_TIMEOUT_S` (default 180) of the deletion, on the same pod, with the same claimable launches (ids and tokens) and task states.
- **Context.** `--fresh` saves the current context and restores it after `kind create cluster`. A `KUBE_CONTEXT` other than `kind-$KIND_CLUSTER` exits 2.

## Capabilities

### Modified Capabilities
- `cluster-runtime`: "Smoke test" (arguments, context, the volume check), "Smoke restart drill", "Smoke Postgres-outage drill" and "Smoke test options" are MODIFIED; "Smoke Postgres-restart drill" is ADDED.

Archive order: "Smoke test" is modified by `store-selection`, and the three drill requirements are added by `restart-drill`. Archive this change after both, so its MODIFIED blocks replace their text.

## Impact

- `deploy/smoke.sh`, `deploy/README.md` (Smoke test section), `test/host/smoke.test.ts`.
- No source change.
