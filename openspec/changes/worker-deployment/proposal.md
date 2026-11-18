## Why

ORC-22 shipped the remote worker loop (`orchestrator-worker`), but nothing runs it in the cluster, and the smoke test still works `SMOKE` with a local claim in the daemon pod. M3 (ORC-25, cloud-native) claims that worker pods finish a run: each smoke task lands on origin's integration branch, the run reports finished, and the worker logs show one accepted report per task.

## What Changes

- `deploy/base/worker.yaml`: Deployment `orchestrator-worker`, `replicas: 0`, label `app.kubernetes.io/name: orchestrator-worker`, command `orchestrator-worker`, `POD_NAME` from the Downward API, `ORCH_API` at the daemon Service, an `emptyDir` clone cache at `/var/cache/orchestrator`.
- Kind overlay: its own `orchestrator.yaml` (`behavior: replace`) with `runner.access: remote` `git.workerOriginUrl: git://git-origin.orch.svc:9418/fixture.git` and `capacity: 3`; `ORCH_WORKER_AGENT=scripted` on the workers; graph tasks `SMOKE-M3-A` and `SMOKE-M3-B` depending on `SMOKE`; fixture `.gitattributes` with `README.md merge=union` so the concurrent README appends rebase without conflict.
- Worker loop: `ORCH_WORKER_TASK` (claim only that task id) and `ORCH_WORKER_MAX_LAUNCHES` (exit 0 after that many launches).
- Image: `orchestrator-worker` linked into `/usr/local/bin`.
- `deploy/smoke.sh`: `SMOKE` is worked by a one-shot `smoke-worker` pod; every claim the script makes carries `access: remote`; it waits for all three dependants to be claimable before the drill snapshot; after the drills it scales the workers to 2 and asserts the three M3 lines. Startup recovery never prepares a remote parked launch again (it has no worktree on the daemon), so under remote access the four recovery assertions of the restart and Postgres-restart drills keep their names and assert that recovery left each recorded parked launch alone: no `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` names one after the recorded sequence, waiting on `/readyz`, `latestSeq` and a readable claimable set; the unchanged launch id and token checks carry the proof (operator decision on question seq 2 of ORC-25).
- `deploy/README.md`: the worker Deployment, `runner.access: remote`, `git.workerOriginUrl`, the M3 smoke step.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cluster-runtime`: Worker Deployment and Smoke M3 step added; Daemon image, Reference manifests, Smoke test, Smoke worker step, Smoke restart drill and Smoke Postgres-restart drill modified.
- `worker-pool`: Task filter and launch limit added.

## Impact

`deploy/base/{worker.yaml,kustomization.yaml}`, `deploy/overlays/kind/{orchestrator.yaml,kustomization.yaml,graph.yaml,git-origin.yaml,fixture/.gitattributes}`, `deploy/smoke.sh`, `deploy/README.md`, `Dockerfile`, `src/worker/loop.ts`, `test/host/{deploy,docker}.test.ts`, `test/worker/loop.test.ts`.
