# deploy

Everything for running the orchestrator in a cluster lives here.

## Daemon image

The image is `orchestrator:dev` when built locally, from the `Dockerfile` at the repository root:

```sh
docker build -t orchestrator:dev .
```

It is multi-stage on `node:22-slim`: the build stage compiles `dist/`, and the final stage holds Node, `git`, `openssh-client`, the built `dist/src`, and production dependencies only. It carries no project toolchain; workers and verifiers get their own images.

Two entrypoints are on `PATH`:

- `orchestrator`: the daemon (the default command).
- `orchestrator-ctl`: the operator CLI.

```sh
docker run --rm orchestrator:dev orchestrator --help
docker run --rm orchestrator:dev orchestrator-ctl
```

The image runs as the unprivileged `node` user.

## Probes

The daemon answers two unauthenticated probes on its API port. Neither one counts as activity for the idle exit.

- `GET /healthz`: 200 `{ ok: true }` whenever the process is serving. Use it for liveness.
- `GET /readyz`: 200 `{ ok: true }` when the store answers a query, the repository path is readable, and the integration branch resolves to a commit. Otherwise it answers 503 `{ ok: false, reasons: [...] }`, with one entry per failed check. Use it for readiness.

## Manifests

Kustomize, rendered with `kubectl kustomize` (no cluster is contacted):

```sh
kubectl kustomize deploy/base
kubectl kustomize deploy/overlays/kind
```

```
deploy/
  base/                 the daemon, in namespace orch
    kustomization.yaml
    namespace.yaml      Namespace orch
    orchestrator.yaml   } ConfigMap orchestrator-config (hash-suffixed, so a change rolls the daemon)
    graph.yaml          }
    pvc.yaml            PersistentVolumeClaim orchestrator-data
    deployment.yaml     Deployment orchestrator (Recreate)
    service.yaml        Service orchestrator, ClusterIP, port 8080
  overlays/kind/        base plus an in-cluster git origin
    kustomization.yaml  sets REPO_URL to the origin
    git-origin.yaml     PVC, Deployment and Service git-origin
    fixture/            the files seeded into the origin's repository
```

### The daemon

The `orchestrator` Deployment runs one daemon with strategy `Recreate`, so two never share the volume. The data volume is mounted at `/data`:

- `/data/repo`: the clone the daemon integrates into.
- `/data/home`: `ORCH_HOME`, so the run directory (store, worktrees, logs) survives restarts.

The init container `clone` clones `REPO_URL` into `/data/repo` when no clone is there yet; later starts keep the existing clone. The daemon container then runs `orchestrator --repo /data/repo`, with `/healthz` as its liveness probe and `/readyz` as its readiness probe.

`orchestrator --repo` reads `<repo>/orchestrator.yaml`, so the ConfigMap's `orchestrator.yaml` and `graph.yaml` are mounted into the clone with `subPath` and listed in the clone's `.git/info/exclude`. They take precedence over files of the same name in the project. The configuration is:

- `runner.mode: pull`: workers claim launches; the daemon spawns nothing.
- `daemon.idleExitMs: 0`: the daemon never exits on its own.
- `apiBind: 0.0.0.0` and `apiPort: 8080`: the API listens where the Service sends traffic.
- `apiBaseUrl: http://orchestrator.orch.svc:8080`: the URL advertised to agents.
- `graphPath: graph.yaml`: the graph is the ConfigMap's, not one in the run directory.

The daemon container sets `ORCH_LOG_FORMAT=json`, so every stderr line is one JSON object with `ts`, `level`, `msg`, and the line's data fields. On SIGTERM (a rollout or `kubectl delete pod`) the daemon stops its tick loop, finishes the in-flight tick and verifier job, closes the API server, writes the exit record to `daemon.json`, and exits 0; after 8 seconds it exits anyway, and an abandoned check restarts from `queued` on the next start. `daemon.pid` and `daemon.json` are still written in the run directory, but nothing in the cluster reads them. A client outside the pod reaches the daemon with `ORCH_URL`; when that names a non-loopback host, `orchestrator-ctl` and the operator MCP server never start a local daemon and report the URL as unreachable instead.

The mounted graph is read-only: change it by editing `graph.yaml` here and re-applying. Operations that write the graph file (import, accepting a proposal) fail in this layout.

### The `REPO_URL` contract

`REPO_URL` is an environment variable on the `clone` init container: any URL `git clone` accepts from inside the pod, of a repository that has the integration branch (`main` unless configured). The base sets a placeholder that fails to clone; an overlay must replace it, for example with a JSON patch on `/spec/template/spec/initContainers/0/env/0`. The clone's `origin` is that URL. Only the first start clones: changing `REPO_URL` later does not re-clone an existing volume.

### The kind overlay

`deploy/overlays/kind` adds `git-origin`, a stand-in for the project's real remote until the hardening milestone. On first start its init container commits the files in `fixture/` on `main` and clones them bare to `/srv/git/fixture.git` on its own volume; the container runs `git daemon` with `receive-pack` enabled, so pushes are accepted. The overlay points the daemon at it:

```
REPO_URL=git://git-origin.orch.svc:9418/fixture.git
```

Every fixture file is listed in the overlay's `configMapGenerator`; add a file there when adding one to `fixture/`.

The overlay also merges its own `graph.yaml` into `orchestrator-config`, replacing the base's empty graph with one ready task, `SMOKE`. The daemon, in pull mode, prepares a launch for it and parks it as claimable, which is what the smoke test looks for.

Both Deployments use `orchestrator:dev`, so a kind cluster needs only that image:

```sh
docker build -t orchestrator:dev .
kind load docker-image orchestrator:dev
kubectl apply -k deploy/overlays/kind
```

## Smoke test

`deploy/smoke.sh` is the cluster-level acceptance test. Each milestone adds its own assertions to it. It needs `docker`, `kind`, `kubectl`, `curl` and `jq`, and an existing kind cluster:

```sh
kind create cluster --name orch     # once
deploy/smoke.sh                     # against the cluster named by KIND_CLUSTER (default orch)
KIND_CLUSTER=dev deploy/smoke.sh    # another cluster
deploy/smoke.sh --dry-run           # print each step's command, execute nothing
```

The steps run in this order:

1. `docker build -t orchestrator:dev .`
2. `kind load docker-image orchestrator:dev --name "$KIND_CLUSTER"`
3. `kubectl apply -k deploy/overlays/kind`
4. `kubectl rollout status` for `git-origin`, then for `orchestrator`
5. `kubectl port-forward service/orchestrator` to `127.0.0.1:$LOCAL_PORT` (default 18080), then wait for `/healthz`
6. The assertions, polled against `/v1/status` until they hold or `STATUS_TIMEOUT_S` (default 120) seconds pass

It asserts:

- M1: `runner.mode` is `pull` and `claimable` is non-empty. The daemon runs in the cluster in pull mode and has parked a launch for the overlay's `SMOKE` task.

Every `kubectl` call passes `--context "$KUBE_CONTEXT"`, default `kind-$KIND_CLUSTER`, so the script never touches whatever context is current. `IMAGE` and `ROLLOUT_TIMEOUT` (default `300s`) can also be overridden. The script exits non-zero at the first step that fails. `test/host/smoke.test.ts` runs the dry run, with every tool stubbed out, and checks the order of the steps.
