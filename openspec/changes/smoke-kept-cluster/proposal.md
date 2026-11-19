## Why

Since ORC-25's M3 step publishes every smoke task, a full pass of `deploy/smoke.sh` leaves the run finished. A second run without `--fresh` on the kept cluster then fails at `M1: pull mode with a claimable launch` after `STATUS_TIMEOUT_S`, and by then it has rebuilt and loaded the image, reapplied the overlay (setting `orchestrator-worker` back to 0 replicas) and sent the graph. The spec and README still said the rerun works (ORC-145, found in the CLOUD-M3 review).

## What Changes

- `deploy/smoke.sh` gains `finished_run_check`. Without `--fresh` it runs first, after the arguments are checked and before the image build: it reads `/v1/status` through the API server's Service proxy (`kubectl --context "$KUBE_CONTEXT" --request-timeout=10s get --raw /api/v1/namespaces/orch/services/orchestrator:api/proxy/v1/status`). On `finished: true` it removes the EXIT trap, prints one line on stderr naming `--fresh`, and exits 2. No answer, or a `finished` that is not `true`, lets the script go on. With `--fresh` it prints `smoke: skip: finished-run check (--fresh starts a new cluster)`; under `--dry-run` it is the step `+ finished_run_check`.
- The local-port probe moves below the check, so a refused rerun prints only its own line (a dry run probes nothing, as before).
- `deploy/README.md` "Smoke test": the rerun rule, and the kept-cluster skip line of the worker step applies to an unfinished run.
- `test/host/smoke.test.ts`: dry-run order and skip line; stub runs for a finished run (with and without `--real-agent`), an unfinished one, a failing read and a non-JSON body.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cluster-runtime`: ADDED "Smoke finished-run check"; MODIFIED "Smoke worker step" (the scenario "A rerun on a kept cluster" names an unfinished run).

## Impact

- `deploy/smoke.sh`, `deploy/README.md`, `test/host/smoke.test.ts`.
- Not proven: whether a rerun on an unfinished run passes depends on where the earlier pass stopped. Once the daemon requires a token (ORC-34), the status read is answered 401 and the check lets the script go on.
