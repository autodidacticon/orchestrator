## MODIFIED Requirements

### Requirement: Probes
The daemon SHALL answer `GET /healthz` with 200 `{ ok: true }` whenever the process serves, and `GET /readyz` with 200 `{ ok: true }` only when the store answers a query and reports itself ready, the repository path is readable, and the integration branch resolves to a commit, else 503 `{ ok: false, reasons }` with one entry per failed check (an unreadable repository also reports the branch as unchecked). A journaled store is not ready while its lag has been above zero for longer than one flush retry, and once its run lock is lost. Neither route SHALL require a token, and neither SHALL count as activity for the idle exit.

#### Scenario: Healthy daemon
- **WHEN** `/healthz` and `/readyz` are called on a running daemon without a token
- **THEN** both answer 200 `{ ok: true }`

#### Scenario: Branch gone
- **WHEN** the integration branch is deleted from the repository and `/readyz` is called
- **THEN** it answers 503 with a reason naming the branch, while `/healthz` still answers 200

#### Scenario: Store lagging or lock lost
- **WHEN** a Postgres store's batches have not landed for longer than one flush retry, or its lock-holding session is gone
- **THEN** `/readyz` answers 503 with a `store:` reason, while `/healthz` still answers 200

#### Scenario: Probes do not reset the idle clock
- **WHEN** a quiescent daemon receives a long sequence of `/healthz` and `/readyz` calls followed by one plain `GET /v1/status`
- **THEN** `idle.idleMs` keeps growing through the probes and resets to zero only at the status call

### Requirement: Reference manifests
`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a hash-suffixed ConfigMap `orchestrator-config` holding only `orchestrator.yaml` (`runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl` naming the Service, `store.kind: postgres`, `git.pushIntegration: true`); a CloudNativePG `Cluster` `postgres`; a Deployment `orchestrator` with strategy `Recreate`, an `emptyDir` at `/data` and no volume claim, an init container `clone` that clones `REPO_URL` into `/data/repo`, a daemon container running `orchestrator --repo /data/repo` with `ORCH_HOME=/data/home`, `ORCH_LOG_FORMAT=json` and `DATABASE_URL` from the Secret `postgres-app` key `uri`, the ConfigMap's file mounted into the clone with `subPath`, and probes on `/healthz` and `/readyz`; and a ClusterIP Service `orchestrator` on port 8080. The run lock, not the strategy, prevents two writers. `deploy/overlays/kind` SHALL add a `git-origin` serving a bare repository seeded from `fixture/` with `receive-pack` enabled, and SHALL patch `REPO_URL` to it.

#### Scenario: Base renders every resource
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the output holds the Namespace, the ConfigMap, the Postgres Cluster, the Recreate Deployment on an `emptyDir` reading `DATABASE_URL` from the Secret, and the Service, and no PersistentVolumeClaim

#### Scenario: Kind overlay supplies the origin and a ready task
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output adds `git-origin` and points `REPO_URL` at it; the overlay's `graph.yaml` is not mounted, and it holds one ready task that the daemon parks as claimable once the smoke script sends it with `PUT /v1/graph`

### Requirement: Smoke test
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`, port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses. Every `kubectl` call SHALL pass `--context "$KUBE_CONTEXT"`. `--dry-run` SHALL print each step, execute nothing, and exit 0; any other argument SHALL exit 2. M1 asserts pull mode and a claimable launch. M2 asserts that no volume claim matches `orchestrator`, then deletes the daemon pod and asserts the new pod serves the same `graphRev` with a claimable launch.

#### Scenario: Dry run prints the steps in order
- **WHEN** `deploy/smoke.sh --dry-run` runs with every tool stubbed out
- **THEN** it prints the build, load, operator install, apply, waits, port-forward, graph upload, M1 poll, claim check, pod deletion and M2 poll in that order, executes nothing, and exits 0

#### Scenario: No daemon claim
- **WHEN** `deploy/smoke.sh` has run against a cluster
- **THEN** `kubectl -n orch get pvc` lists no claim matching `orchestrator`

#### Scenario: Cluster name is honoured
- **WHEN** `KIND_CLUSTER=dev deploy/smoke.sh --dry-run` runs
- **THEN** the load step names `--name dev` and every `kubectl` step carries `--context kind-dev`

#### Scenario: Unknown argument
- **WHEN** `deploy/smoke.sh --verbose` runs
- **THEN** it prints usage to stderr and exits 2

## REMOVED Requirements

### Requirement: Mounted graph is read-only
**Reason**: the graph lives in the store; `PUT /v1/graph` writes the proposed-graph slot (see graph-import "Graph source by store kind").
**Migration**: send the graph with `PUT /v1/graph` instead of editing a mounted `graph.yaml`.
