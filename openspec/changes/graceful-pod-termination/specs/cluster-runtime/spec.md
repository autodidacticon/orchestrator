## MODIFIED Requirements

### Requirement: Worker Deployment
`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `replicas: 0`, whose pods carry the label `app.kubernetes.io/name: orchestrator-worker` (so no selector of the daemon matches them), run as uid and gid 1000 with `fsGroup` 1000, set `terminationGracePeriodSeconds: 120` (the time the loop's hand-back on SIGTERM needs with every wait at its limit, see specs/worker-pool "Pod termination"), and hold one container on `orchestrator:dev` with command `orchestrator-worker` and no `lifecycle` (no preStop hook: the container's command is the loop, which gets the kubelet's SIGTERM itself); `POD_NAME` from `metadata.name` through the Downward API; `ORCH_API` set to the daemon Service URL `http://orchestrator.orch.svc:8080`; and an `emptyDir` mounted at the clone cache, `/var/cache/orchestrator` (`ORCH_WORKER_CACHE`). It SHALL have no volume claim. The base names no agent. `deploy/README.md` SHALL describe the worker Deployment, `runner.access: remote`, `git.workerOriginUrl`, the termination on SIGTERM, and the M3 smoke step.

#### Scenario: Worker Deployment rendered
- **WHEN** `kubectl kustomize deploy/base` or `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output holds Deployment `orchestrator-worker` with `replicas: 0`, command `orchestrator-worker`, `POD_NAME` from `metadata.name`, `ORCH_API` at the daemon Service, and an `emptyDir` at the clone cache; only the kind overlay sets `ORCH_WORKER_AGENT=scripted`, and `test/host/deploy.test.ts` asserts each of these

#### Scenario: Worker termination grace period
- **WHEN** `kubectl kustomize deploy/base` or `kubectl kustomize deploy/overlays/kind` runs
- **THEN** Deployment `orchestrator-worker` has `terminationGracePeriodSeconds: 120` and its container has no `lifecycle`, and `test/host/worker-termination.test.ts` asserts both
