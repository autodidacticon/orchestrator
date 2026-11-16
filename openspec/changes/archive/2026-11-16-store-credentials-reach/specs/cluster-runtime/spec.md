## MODIFIED Requirements

### Requirement: Reference manifests
`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a hash-suffixed ConfigMap `orchestrator-config` holding only `orchestrator.yaml` (`runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl` naming the Service, `store.kind: postgres`, `store.urlFile: /var/run/secrets/orchestrator/postgres/uri`, `git.pushIntegration: true`); a CloudNativePG `Cluster` `postgres`; a Deployment `orchestrator` with strategy `Recreate`, an `emptyDir` at `/data` and no volume claim, an init container `clone` that clones `REPO_URL` into `/data/repo`, a daemon container running `orchestrator --repo /data/repo` with `ORCH_HOME=/data/home` and `ORCH_LOG_FORMAT=json`, the Secret `postgres-app` key `uri` mounted read-only as the file `uri` under `/var/run/secrets/orchestrator/postgres` (mode 0440, readable through the pod's `fsGroup`), no `DATABASE_URL`, no `DATABASE_URL_FILE`, no variable starting with `PG` and no variable read from a Secret, the ConfigMap's file mounted into the clone with `subPath`, and probes on `/healthz` and `/readyz`; and a ClusterIP Service `orchestrator` on port 8080. The run lock, not the strategy, prevents two writers. `deploy/overlays/kind` SHALL add a `git-origin` serving a bare repository seeded from `fixture/` with `receive-pack` enabled, and SHALL patch `REPO_URL` to it.

#### Scenario: Base renders every resource
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the output holds the Namespace, the ConfigMap, the Postgres Cluster, the Recreate Deployment on an `emptyDir` reading the store URL from the Secret mounted as a file and holding no store URL, password or libpq variable in its environment, and the Service, and no PersistentVolumeClaim

#### Scenario: Kind overlay supplies the origin and a ready task
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output adds `git-origin` and points `REPO_URL` at it; the overlay's `graph.yaml` is not mounted, and it holds one ready task that the daemon parks as claimable once the smoke script sends it with `PUT /v1/graph`
