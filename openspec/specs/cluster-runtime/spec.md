# Cluster Runtime Specification

## Purpose
Running the orchestrator daemon as a long-lived container on Kubernetes: the address it binds and the URL it advertises, the health probes a pod uses, the daemon image, the reference kustomize manifests with their kind overlay and git-origin fixture, the smoke test that proves a milestone against a live cluster, and the limitation of a graph mounted from a ConfigMap. The process-level behaviour a container needs (signals, log format, pid file, remote URL) is specified in operator-control "Container mode".

## Requirements

### Requirement: Bind host and advertised URL
The configuration SHALL accept `apiBind`, a non-empty string defaulting to `127.0.0.1`, and `apiBaseUrl`, an optional URL. The API server SHALL bind to `apiBind` and SHALL advertise `apiBaseUrl` without a trailing slash when it is set, else `http://<apiBind>:<port>` with an IPv6 bind bracketed. The advertised URL SHALL be the one stored in kv and `daemon.json`, embedded in briefs, returned by claims, and reported by `status`. Both keys SHALL be file keys only: they are read at start and SHALL NOT be in the runtime override set, so `configure` and `PUT /v1/config` do not accept them. With neither key set the daemon SHALL behave exactly as before: loopback bind, loopback URL.

#### Scenario: Cluster bind and Service URL
- **WHEN** the daemon starts with `apiBind: 0.0.0.0` and `apiBaseUrl: http://orchestrator:8080`
- **THEN** the server answers on a non-loopback address, and `status`, `daemon.json`, kv, a claim response, and a prepared brief all carry `http://orchestrator:8080`

#### Scenario: Laptop defaults unchanged
- **WHEN** the daemon starts with neither key set
- **THEN** it binds `127.0.0.1` and advertises `http://127.0.0.1:<port>`

### Requirement: Probes
The daemon SHALL answer `GET /healthz` with 200 `{ ok: true }` whenever the process serves, and `GET /readyz` with 200 `{ ok: true }` only when the store answers a query, the repository path is readable, and the integration branch resolves to a commit, else 503 `{ ok: false, reasons }` with one entry per failed check (an unreadable repository also reports the branch as unchecked). Neither route SHALL require a token, and neither SHALL count as activity for the idle exit.

#### Scenario: Healthy daemon
- **WHEN** `/healthz` and `/readyz` are called on a running daemon without a token
- **THEN** both answer 200 `{ ok: true }`

#### Scenario: Branch gone
- **WHEN** the integration branch is deleted from the repository and `/readyz` is called
- **THEN** it answers 503 with a reason naming the branch, while `/healthz` still answers 200

#### Scenario: Probes do not reset the idle clock
- **WHEN** a quiescent daemon receives a long sequence of `/healthz` and `/readyz` calls followed by one plain `GET /v1/status`
- **THEN** `idle.idleMs` keeps growing through the probes and resets to zero only at the status call

### Requirement: Daemon image
The repository SHALL carry a multi-stage `Dockerfile` on `node:22-slim` whose build stage compiles `dist/` and whose final stage holds `git`, `openssh-client`, `ca-certificates`, the built `dist/src`, and production dependencies only, runs as the unprivileged `node` user, and puts `orchestrator` (the default command) and `orchestrator-ctl` on `PATH`. It SHALL carry no project toolchain beyond Node; workers and verifiers get their own images. A `.dockerignore` SHALL keep `node_modules`, `dist`, `.git`, run data, SQLite files, test fixtures, and the plugin's `node_modules` out of the build context. `deploy/README.md` SHALL name the image, the build command, and both entrypoints.

#### Scenario: Image contents asserted without a Docker daemon
- **WHEN** `test/host/docker.test.ts` runs
- **THEN** it reads the Dockerfile and `.dockerignore` and asserts the base image, the two stages, the installed packages, the production-only install, the two entrypoints, and the ignored paths

#### Scenario: Entrypoints on PATH
- **WHEN** `docker run --rm orchestrator:dev orchestrator-ctl` and `docker run --rm orchestrator:dev orchestrator --help` are run
- **THEN** each prints its usage

### Requirement: Reference manifests
`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a hash-suffixed ConfigMap `orchestrator-config` holding `orchestrator.yaml` (`runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl` naming the Service, `graphPath: graph.yaml`) and a `graph.yaml`; a PersistentVolumeClaim `orchestrator-data`; a Deployment `orchestrator` with strategy `Recreate`, an init container `clone` that clones the `REPO_URL` environment variable into `/data/repo` only when no clone exists, a daemon container running `orchestrator --repo /data/repo` with `ORCH_HOME=/data/home` and `ORCH_LOG_FORMAT=json`, the ConfigMap files mounted into the clone with `subPath`, and liveness and readiness probes on `/healthz` and `/readyz`; and a ClusterIP Service `orchestrator` on port 8080. The base SHALL set a `REPO_URL` placeholder that fails to clone, so an overlay must supply the remote. `deploy/overlays/kind` SHALL add a `git-origin` PersistentVolumeClaim, Deployment, and Service serving a bare repository seeded on `main` from `deploy/overlays/kind/fixture/` with `receive-pack` enabled, SHALL patch `REPO_URL` to `git://git-origin.orch.svc:9418/fixture.git`, and SHALL merge its own `graph.yaml` with one ready task into `orchestrator-config`. Both kustomizations SHALL render with `kubectl kustomize` without contacting a cluster.

#### Scenario: Base renders every resource
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the output holds the Namespace, the ConfigMap with the pull-mode never-idle cluster-bound `orchestrator.yaml` and a `graph.yaml`, the PersistentVolumeClaim, the Recreate Deployment with the clone init container and the `orchestrator --repo` command, and the ClusterIP Service on 8080

#### Scenario: Kind overlay supplies the origin and a ready task
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output adds `git-origin`, points `REPO_URL` at it, and the merged ConfigMap's `graph.yaml` holds one ready task that the daemon will park as claimable

### Requirement: Mounted graph is read-only
In the reference manifests the graph is a ConfigMap mount, so operations that write the graph file (`PUT /v1/graph`, import, accepting a proposal) SHALL fail in that layout; the graph is changed by editing the overlay's `graph.yaml` and re-applying. This limitation SHALL stand until the graph lives in the store.

#### Scenario: Import against the mounted graph
- **WHEN** `import_graph` is called on a daemon running from the reference manifests
- **THEN** the write to `graph.yaml` fails and the response reports the error; the active graph is unchanged

### Requirement: Smoke test
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, `kind load docker-image` into the cluster named by `KIND_CLUSTER` (default `orch`), `kubectl apply -k deploy/overlays/kind`, wait for the `git-origin` and then the `orchestrator` rollouts, port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080) and wait for `/healthz`, then poll `/v1/status` with `curl` and `jq` until the milestone assertions hold or `STATUS_TIMEOUT_S` (default 120) elapses. Every `kubectl` call SHALL pass `--context "$KUBE_CONTEXT"`, defaulting to `kind-$KIND_CLUSTER`, so the script never touches the current context. `--dry-run` SHALL print each step's command, execute nothing, and exit 0; any other argument SHALL exit 2 with usage. The M1 assertion is that `runner.mode` is `pull` and `claimable` is non-empty. Each later milestone SHALL add its assertions below the earlier ones.

#### Scenario: Dry run prints the steps in order
- **WHEN** `deploy/smoke.sh --dry-run` runs with every tool stubbed out
- **THEN** it prints the build, load, apply, two rollout waits, port-forward, health wait, and status poll in that order, executes nothing, and exits 0

#### Scenario: Cluster name is honoured
- **WHEN** `KIND_CLUSTER=dev deploy/smoke.sh --dry-run` runs
- **THEN** the load step names `--name dev` and every `kubectl` step carries `--context kind-dev`

#### Scenario: Unknown argument
- **WHEN** `deploy/smoke.sh --verbose` runs
- **THEN** it prints usage to stderr and exits 2
