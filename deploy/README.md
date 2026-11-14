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

#### The run id

Many runs can share one database: their rows are keyed by `run_id`, and each daemon holds an advisory lock keyed by it. Every deployment from this manifest clones into the same path, `/data/repo`, so the run id does not come from the path. With `store.kind: postgres` the daemon picks it in this order:

1. `store.runId` in `orchestrator.yaml` (the ConfigMap);
2. the environment variable `ORCH_RUN_ID`;
3. a hash of `git.originUrl`, when set;
4. with `git.pushIntegration: true`, a hash of the clone's `origin` remote, which is `REPO_URL`. This is what the base manifest uses: each deployment cloning a different repository gets its own run id, with nothing to set. User information in the URL (a token) is left out of the hash, so rotating a credential keeps the id;
5. otherwise the repository path hash, with one warning in the log. Every deployment on the same path and database would share that run.

Set `store.runId` or `ORCH_RUN_ID` when two deployments clone the same repository into one database (for example a staging and a production run of one project), or when the id must survive a change of `REPO_URL`. An explicit id is 1 to 64 characters of `A-Z a-z 0-9 _ -`; any other value stops the daemon at startup with a message naming it. The run directory under `ORCH_HOME` is named after the id, and `deploy/smoke.sh` reads it from `/v1/status` (`runDir`).

The store's connection does not reach check commands or agents (of every runner kind, nor what they start): they run without `DATABASE_URL`, `ORCH_RUN_ID`, and any variable whose value is the store URL. A `store.url` written in a config file that git tracks is refused at startup, because every worktree would carry it. The mounted `orchestrator.yaml` is excluded from the clone. The daemon's own git commands still inherit its environment. A project git hook they run, such as `pre-commit` on a kept-release WIP commit, can see `DATABASE_URL`.

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
deploy/smoke.sh --fresh             # delete and recreate the kind cluster first
deploy/smoke.sh --break pvc         # falsify one restart-drill assertion on purpose (pvc or claimable); exits 1
```

These are the only arguments: `--dry-run`, `--fresh` and `--break pvc|claimable`. Anything else, or another `--break` value, prints usage and exits 2.

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
- M2: no volume of the daemon pod is backed by a claim (`persistentVolumeClaim` or `ephemeral`), whatever the claim is called. The script reads the pod's volumes, not the claim names in the namespace. Postgres and `git-origin` keep their own claims.
- M2 restart drill. The graph has `SMOKE` and `SMOKE-PARKED`, which depends on it. The script works `SMOKE` itself as a pull-mode worker: it claims the launch, commits in the pod's worktree with `kubectl exec`, and submits with the launch token. It waits until the in-pod verifier has published `SMOKE` to origin and `SMOKE-PARKED` is claimable. It then records three things:
  - from the API: the claimable launches as launch id and task id, the task states, `latestSeq`, the integration head (the `publishedSha` of `SMOKE`'s transition to `done`), and the daemon pod's uid. `/v1/status` lists claimable tasks only, so the launch ids come from `/v1/events`: a launch is claimable when its latest `launch.claimable`, `launch.claimed`, `launch.released`, `launch.ended`, `launch.revoked` or `launch.failed` event is `launch.claimable`, and those launches' tasks must equal `/v1/status` `claimable`;
  - through `psql` on the CloudNativePG pod: `select status, count(*) from launches where run_id = ... group by 1`, the claimable launches as launch id, task id and `md5(token)`, and the task states;
  - a check that the API and `psql` agree.

  Then it deletes the daemon pod. After the rollout, the new pod runs on a fresh clone and an empty run directory. `/readyz` passes before the daemon's startup recovery runs, so the script first waits until every recorded claimable launch has a recovery event (`launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed`) after the recorded sequence. It asserts that:
  - the pod's uid is new, and the same `graphRev` is served;
  - the claimable launches are unchanged by launch id (API) and by launch id and token (`psql`), and so are the task states and the launch counts. A launch replaced by a new one for the same task fails `drill: claimable set unchanged (API)`;
  - origin's `main` and the clone are at the recorded head, and origin's history carries the `Orchestrator-Task: SMOKE` commit;
  - exactly one `launch.reprepared` event per claimable launch follows the recorded sequence;
  - the new daemon pod still mounts no claim.
- M2 Postgres-outage drill. The script freezes every `postgres` process in the instance pod with SIGSTOP for `OUTAGE_S` seconds (default 10). One write stays pending meanwhile: a claim for a task that does not exist, whose response waits for durability. Just before the thaw, the script checks that this request is still running with no answer and that `storePendingBatches` is above zero. While Postgres is frozen, `/readyz` must answer 503 at least once, and only 200 or 503; curl's `000` (no answer) fails the assertion. `/v1/status` must answer with `storeLagMs` rising. After SIGCONT, the lag must return to zero, `/readyz` must pass, the write must answer 404, and the daemon pod's uid and restart count must be unchanged.

  The drill freezes Postgres rather than scaling it to zero. The journal sink never reconnects, and a lost session is fatal, so scale-to-zero restarts the daemon by design. A NetworkPolicy does not stall the session either, because kindnet enforces policies only on new connections. Keep `OUTAGE_S` well under 30: CloudNativePG's liveness probe (3 × 10s) restarts a frozen Postgres, which ends the session and so the daemon.
- M2 Postgres-restart drill. The script records the claimable launches and task states (API and `psql`), the daemon pod's uid and its restart count, then deletes the Postgres pod and waits until it is gone. CloudNativePG's smart shutdown waits for open sessions, the daemon's included, for up to the Cluster's `smartShutdownTimeout` (180s by default), so this step takes about three minutes. The daemon then loses its session and the run lock and exits. The script asserts that:
  - the daemon container restarts within `PG_EXIT_TIMEOUT_S` (default 60) seconds of the old Postgres pod being gone;
  - within `PG_READY_TIMEOUT_S` (default 120) seconds of that, the pod is Ready and `/readyz` answers 200 through a new port-forward (measured on kind: about 12s);
  - after `SETTLE_S` (default 5) seconds, it is the same pod, and the claimable launches (ids, and tokens through `psql`) and the task states are unchanged.
- Last, a claim of `SMOKE-PARKED` must return a launch id and token (compared by md5 in `psql`) recorded before the first restart. The script then releases that launch.

`--break` falsifies one assertion on purpose. The script must then fail at that assertion, with every earlier one passing:

- `--break pvc` creates a claim named `data-smoke-break` and mounts it into the daemon container with a Deployment patch. It waits for that rollout's recovery and then takes the snapshot. The restart drill fails with `smoke: FAIL: drill: the daemon pod mounts no volume claim`. On exit the script removes the volume and the mount from the Deployment, which rolls the daemon again, and deletes the claim.
- `--break claimable` claims `SMOKE-PARKED`'s launch after the snapshot and before the restart. Recovery ends that launch and parks a new one for the same task, so the run fails with `smoke: FAIL: drill: claimable set unchanged (API)`.

Each assertion prints `smoke: pass: <name>`. The first one that does not hold prints `smoke: FAIL: <name>`, and the script exits 1. A full pass ends with `smoke: ok`. On a kept cluster, a rerun skips the worker step when `SMOKE` is already done. `PUBLISH_TIMEOUT_S` (default 300) bounds the wait for the publish.

Every `kubectl` call that talks to a cluster passes `--context "$KUBE_CONTEXT"`. Its only accepted value is `kind-$KIND_CLUSTER`, the default. Any other value exits 2 before the first step, so the image always goes to the cluster being tested. The script leaves the current kubectl context as it found it. The exception is `kind create cluster` under `--fresh`, which makes the new cluster current. So `--fresh` reads `kubectl config current-context` first, and afterwards runs `kubectl config use-context` with that value, or `kubectl config unset current-context` if none was set. These three `kubectl config` calls are the only ones without `--context`.

`--break claimable` costs `SMOKE-PARKED` one attempt: recovery fails the task whose claimed launch lost its worktree. After a few such runs on a kept cluster the task runs out of attempts and `drill: SMOKE-PARKED claimable` fails; start again with `--fresh`. The final claim releases its launch without progress, which spends no attempt. `IMAGE`, `ROLLOUT_TIMEOUT` (default `300s`) and `CNPG_MANIFEST` (the operator release to install) can also be overridden. The script exits non-zero at the first step that fails. `test/host/smoke.test.ts` runs the dry run, with every tool stubbed out, and checks the order of the steps.
