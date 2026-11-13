# deploy

Everything for running the orchestrator in a cluster lives here. The specification is `openspec/specs/cluster-runtime/spec.md`, with the process-level behaviour (signalled shutdown, JSON logs, the remote `ORCH_URL`) under the "Container mode" requirement of `openspec/specs/operator-control/spec.md`.

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
- `GET /readyz`: 200 `{ ok: true }` when the store answers a query, the repository path is readable, and the integration branch resolves to a commit. Under a Postgres store it is also not ready while the store's flush lag has been above zero for longer than one flush retry, and once the session holding the run lock is lost. Otherwise it answers 503 `{ ok: false, reasons: [...] }`, with one entry per failed check. Use it for readiness.

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
    orchestrator.yaml   ConfigMap orchestrator-config (hash-suffixed, so a change rolls the daemon)
    postgres.yaml       CloudNativePG Cluster postgres (the run's state)
    deployment.yaml     Deployment orchestrator (Recreate, emptyDir, no volume claim)
    service.yaml        Service orchestrator, ClusterIP, port 8080
  overlays/kind/        base plus an in-cluster git origin
    kustomization.yaml  sets REPO_URL to the origin
    git-origin.yaml     PVC, Deployment and Service git-origin
    graph.yaml          the graph deploy/smoke.sh sends with PUT /v1/graph
    fixture/            the files seeded into the origin's repository
```

### The daemon

The `orchestrator` Deployment runs one daemon with strategy `Recreate`. It has no volume claim: `/data` is an `emptyDir`, so every pod starts empty.

- `/data/repo`: the clone the daemon integrates into, made fresh by the init container on every start.
- `/data/home`: `ORCH_HOME`, the run directory (worktrees, logs, `daemon.json`). Nothing in it has to survive a restart.

The run's state (tasks, launches, events, outbox, the accepted and proposed graphs) is in Postgres: `store.kind: postgres`, with the connection URL in `DATABASE_URL`, read from the CloudNativePG application Secret `postgres-app` (key `uri`). The integration branch and the milestone tags are on origin (`git.pushIntegration: true`). A new pod therefore takes the run lock, loads the run from Postgres, fetches origin, and continues: a parked launch's worktree is prepared again, a claimed launch whose worktree is gone is ended and retried, and a queued verifier job whose sealed commit the new clone lacks fails its task without spending an attempt. Two daemons never write one run: the second one cannot take the run's Postgres lock and exits, and the pod restarts until the first is gone.

The init container `clone` clones `REPO_URL` into `/data/repo`. The daemon container then runs `orchestrator --repo /data/repo`, with `/healthz` as its liveness probe and `/readyz` as its readiness probe.

`orchestrator --repo` reads `<repo>/orchestrator.yaml`, so the ConfigMap's `orchestrator.yaml` is mounted into the clone with `subPath` and listed in the clone's `.git/info/exclude`. It takes precedence over a file of the same name in the project. The configuration is:

- `runner.mode: pull`: workers claim launches; the daemon spawns nothing.
- `daemon.idleExitMs: 0`: the daemon never exits on its own.
- `apiBind: 0.0.0.0` and `apiPort: 8080`: the API listens where the Service sends traffic.
- `apiBaseUrl: http://orchestrator.orch.svc:8080`: the URL advertised to agents.
- `store.kind: postgres` and `store.flushDeadlineMs: 120000`: the daemon exits non-zero when a batch cannot reach Postgres within the deadline, or at once when its session (and the run lock) is lost. The worker lease (`leaseTtlMs`, 10 minutes by default) must be at least the deadline, or the daemon refuses to start.
- `git.pushIntegration: true`: origin is the source of truth for the integration branch.

The database URL carries a password. Every surface that prints resolved config (`orchestrator-ctl start`, `orchestrator-ctl config`, `GET /v1/config`, `config.json`, and the log) shows it with the password removed.

The daemon container sets `ORCH_LOG_FORMAT=json`, so every stderr line is one JSON object with `ts`, `level`, `msg`, and the line's data fields. On SIGTERM (a rollout or `kubectl delete pod`) the daemon stops its tick loop, finishes the in-flight tick and verifier job, closes the API server, writes the exit record to `daemon.json`, and exits 0; after 8 seconds it exits anyway, and an abandoned check restarts from `queued` on the next start. `daemon.pid` and `daemon.json` are still written in the run directory, but nothing in the cluster reads them. A client outside the pod reaches the daemon with `ORCH_URL`; when that names a non-loopback host, `orchestrator-ctl` and the operator MCP server never start a local daemon and report the URL as unreachable instead.

The graph is not mounted. Send it with `PUT /v1/graph` (import, or `deploy/smoke.sh`): under a Postgres store the document goes to the store's proposed-graph slot and is reloaded at once. An accepted document becomes the active graph; a rejected one stays in the proposed slot with its reasons, and the active graph is unchanged, across restarts too. Accepting a proposal edits the proposed document the same way.

### The `REPO_URL` contract

`REPO_URL` is an environment variable on the `clone` init container: any URL `git clone` accepts from inside the pod, of a repository that has the integration branch (`main` unless configured) and accepts the daemon's pushes. The base sets a placeholder that fails to clone; an overlay must replace it, for example with a JSON patch on `/spec/template/spec/initContainers/0/env/0`. The clone's `origin` is that URL, and the daemon pushes publications and milestone tags to it. Every start clones it again.

### The kind overlay

`deploy/overlays/kind` adds `git-origin`, a stand-in for the project's real remote until the hardening milestone. On first start its init container commits the files in `fixture/` on `main` and clones them bare to `/srv/git/fixture.git` on its own volume; the container runs `git daemon` with `receive-pack` enabled, so pushes are accepted. The overlay points the daemon at it:

```
REPO_URL=git://git-origin.orch.svc:9418/fixture.git
```

Every fixture file is listed in the overlay's `configMapGenerator`; add a file there when adding one to `fixture/`.

The overlay's `graph.yaml` holds one ready task, `SMOKE`. It is not mounted: the smoke test sends it with `PUT /v1/graph`, and the daemon, in pull mode, prepares a launch for it and parks it as claimable, which is what the smoke test looks for.

Both Deployments use `orchestrator:dev`, so a kind cluster needs only that image and the CloudNativePG operator:

```sh
docker build -t orchestrator:dev .
kind load docker-image orchestrator:dev
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml
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
3. `kubectl apply --server-side -f "$CNPG_MANIFEST"` (the CloudNativePG operator), then its rollout
4. `kubectl apply -k deploy/overlays/kind`
5. `kubectl wait` for `cluster/postgres` to be Ready, then `kubectl rollout status` for `git-origin` and for `orchestrator`
6. `kubectl port-forward service/orchestrator` to `127.0.0.1:$LOCAL_PORT` (default 18080), then wait for `/healthz`
7. `PUT /v1/graph` with the overlay's `graph.yaml`, which must be accepted
8. The assertions, polled against `/v1/status` until they hold or `STATUS_TIMEOUT_S` (default 120) seconds pass

It asserts:

- M1: `runner.mode` is `pull` and `claimable` is non-empty. The daemon runs in the cluster in pull mode and has parked a launch for the overlay's `SMOKE` task.
- M2: `kubectl get pvc` lists no claim of the daemon's (Postgres and `git-origin` keep their own). Then the daemon's pod is deleted; the new one, on a fresh clone and an empty run directory, serves the same `graphRev` and still has a claimable launch, read back from Postgres.

Every `kubectl` call passes `--context "$KUBE_CONTEXT"`, default `kind-$KIND_CLUSTER`, so the script never touches whatever context is current. `IMAGE`, `ROLLOUT_TIMEOUT` (default `300s`) and `CNPG_MANIFEST` (the operator release to install) can also be overridden. The script exits non-zero at the first step that fails. `test/host/smoke.test.ts` runs the dry run, with every tool stubbed out, and checks the order of the steps.
