## MODIFIED Requirements

### Requirement: Bind host and advertised URL
The configuration SHALL accept `apiBind`, a non-empty string defaulting to `127.0.0.1`, and `apiBaseUrl`, an optional URL. The API server SHALL bind to `apiBind` and SHALL advertise `apiBaseUrl` without a trailing slash when it is set, else `http://<apiBind>:<port>` with an IPv6 bind bracketed. With neither key set the daemon SHALL behave exactly as before: loopback bind, loopback URL.

#### Scenario: Cluster bind and Service URL
- **WHEN** the daemon starts with `apiBind: 0.0.0.0` and `apiBaseUrl: http://orchestrator:8080`
- **THEN** the server answers on a non-loopback address, and `status`, `daemon.json`, kv, a claim response, and a prepared brief all carry `http://orchestrator:8080`

#### Scenario: Laptop defaults unchanged
- **WHEN** the daemon starts with neither key set
- **THEN** it binds `127.0.0.1` and advertises `http://127.0.0.1:<port>`

### Requirement: Probes
The daemon SHALL answer `GET /healthz` with 200 `{ ok: true }` whenever the process serves, and `GET /readyz` with 200 `{ ok: true }` only when the store answers a query and reports itself ready, the repository path is readable, and the integration branch resolves to a commit, else 503 `{ ok: false, reasons }` with one entry per failed check (an unreadable repository also reports the branch as unchecked).

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

### Requirement: Daemon image
The repository SHALL carry a multi-stage `Dockerfile` on `node:22-slim` whose build stage compiles `dist/` and whose final stage holds `git`, `openssh-client`, `ca-certificates`, the built `dist/src`, and production dependencies only, runs as the unprivileged `node` user, and puts `orchestrator` (the default command), `orchestrator-ctl` and `orchestrator-worker` (the remote worker loop, specs/worker-pool) on `PATH`.

#### Scenario: Image contents asserted without a Docker daemon
- **WHEN** `test/host/docker.test.ts` runs
- **THEN** it reads the Dockerfile and `.dockerignore` and asserts the base image, the two stages, the installed packages, the production-only install, the three entrypoints, and the ignored paths

#### Scenario: Entrypoints on PATH
- **WHEN** `docker run --rm orchestrator:dev orchestrator-ctl`, `docker run --rm orchestrator:dev orchestrator --help` and `docker run --rm orchestrator:dev orchestrator-worker --help` are run
- **THEN** each prints its usage

### Requirement: Reference manifests
`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a CloudNativePG `Cluster` `postgres`; a ClusterIP Service `orchestrator` on port 8080; and the worker Deployment `orchestrator-worker` (see "Worker Deployment").

#### Scenario: Base renders every resource
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the output holds the Namespace, the ConfigMap, the Postgres Cluster, the worker Deployment at `replicas: 0`, the Recreate Deployment on an `emptyDir` reading the store URL from the Secret mounted as a file and holding no store URL, password or libpq variable in its environment, and the Service, and no PersistentVolumeClaim

#### Scenario: Kind overlay supplies the origin and a ready task
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output adds `git-origin` and points `REPO_URL` at it; its `orchestrator.yaml` is the base file plus `runner.access: remote`, `git.workerOriginUrl: git://git-origin.orch.svc:9418/fixture.git` and `capacity: 3`; the worker Deployment carries `ORCH_WORKER_AGENT=scripted` and `replicas: 0`; the overlay's `graph.yaml` is not mounted, and it holds one ready task that the daemon parks as claimable once the smoke script sends it with `PUT /v1/graph`

### Requirement: Smoke test
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`. M2 asserts that the daemon pod has no volume backed by a claim, then runs the restart, outage and Postgres-restart drills.

#### Scenario: Dry run prints the steps in order
- **WHEN** `deploy/smoke.sh --dry-run` runs with every tool stubbed out
- **THEN** it prints the build, load, operator install, apply, waits, port-forward, graph upload, M1 poll, claim check, pod deletion and M2 poll in that order, executes nothing, and exits 0

#### Scenario: No daemon claim
- **WHEN** `deploy/smoke.sh` has run against a cluster
- **THEN** no volume of the daemon pod is a `persistentVolumeClaim` or `ephemeral` volume, whatever the claim is named

#### Scenario: Cluster name is honoured
- **WHEN** `KIND_CLUSTER=dev deploy/smoke.sh --dry-run` runs
- **THEN** the load step names `--name dev` and every `kubectl` step carries `--context kind-dev`

#### Scenario: Context and cluster disagree
- **WHEN** `KIND_CLUSTER=dev KUBE_CONTEXT=kind-orch deploy/smoke.sh --dry-run` runs
- **THEN** it names both values on stderr and exits 2 without printing a step

#### Scenario: Fresh cluster restores the context
- **WHEN** `deploy/smoke.sh --fresh` runs while the current context is `prod`
- **THEN** `kubectl config use-context prod` runs right after `kind create cluster`; with no current context, `kubectl config unset current-context` runs instead

#### Scenario: Unknown argument
- **WHEN** `deploy/smoke.sh --verbose` runs
- **THEN** it prints usage to stderr and exits 2

#### Scenario: Usage names the real-agent option
- **WHEN** `deploy/smoke.sh` prints usage
- **THEN** the usage line names `--real-agent <key file>`

### Requirement: Smoke worker step
`deploy/smoke.sh` SHALL work `SMOKE` with one worker pod, `smoke-worker`: `orchestrator-worker` run with `ORCH_WORKER_AGENT=scripted`, `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`, which claims with `access: remote`, clones origin, commits on the launch branch, pushes it and submits with its sha. The step SHALL fail unless the pod exits with phase `Succeeded` and its log shows `report accepted` for `SMOKE`; the pod SHALL be kept for the M3 log assertion.

#### Scenario: One published, one parked
- **WHEN** the worker step and the waits have passed
- **THEN** `/v1/status` lists `SMOKE` in `byStatus.done` and `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B` in `claimable`, and the `smoke-worker` pod has succeeded

#### Scenario: A rerun on a kept cluster
- **WHEN** the script runs again against a cluster whose run is unfinished and where `SMOKE` is already done
- **THEN** it skips the worker step, printing `smoke: skip: working SMOKE` with the reason, and runs the drill against the existing run

### Requirement: Smoke restart drill
Before deleting the daemon pod, `deploy/smoke.sh` SHALL record a snapshot. From the API it records the claimable launches as launch id and task id, the task states, `latestSeq`, the integration head (the `publishedSha` of `SMOKE`'s `transition` to `done`), and the daemon pod's uid. Through `psql` on the CloudNativePG instance pod it records the run's launch counts by status, the claimable launches as launch id, task id and the md5 of the token, and the task states.

#### Scenario: A new pod
- **WHEN** the replacement pod is ready
- **THEN** its uid differs from the recorded one

#### Scenario: State survives the restart
- **WHEN** recovery has settled
- **THEN** the claimable launches (launch id and task id from the API; launch id, task id and token md5 from `psql`) and the task states equal the recorded ones, and the launch counts by status are unchanged

#### Scenario: A claimed launch fails the claimable assertion
- **WHEN** the parked launch was claimed before the restart, so it is no longer the same claimable launch after it (under local access recovery ends it and parks a new launch for the same task; under remote access the claim stays live)
- **THEN** `drill: claimable set unchanged (API)` fails

#### Scenario: Integration head is origin's
- **WHEN** recovery has settled
- **THEN** origin's `main` and the pod's clone are at the recorded head, and origin's history of `main` carries a commit with the `Orchestrator-Task: SMOKE` trailer

#### Scenario: Parked launches are prepared again once each
- **WHEN** recovery has settled under local access
- **THEN** `drill: one launch.reprepared per claimable launch` finds, in the events after the recorded sequence, exactly one `launch.reprepared` for each claimable launch and none for any other launch

#### Scenario: Remote parked launches are kept as they are
- **WHEN** recovery has settled under remote access
- **THEN** `drill: one launch.reprepared per claimable launch` finds no `launch.reprepared` after the recorded sequence, and at least one claimable launch was recorded

#### Scenario: No daemon claim after the restart
- **WHEN** recovery has settled
- **THEN** no volume of the new daemon pod is backed by a claim, whatever its name

### Requirement: Smoke assertions are named
Every assertion in `deploy/smoke.sh` SHALL print `smoke: pass: <name>` when it holds. The first assertion that does not hold SHALL print `smoke: FAIL: <name>` to stderr, and the script SHALL exit 1. A full pass SHALL end with `smoke: ok`. No assertion or step SHALL be skipped silently: one that does not run SHALL print `smoke: skip: <name> (<why>)` on stdout. No environment variable SHALL turn an assertion off.

#### Scenario: A false assertion fails the run
- **WHEN** a restart-drill assertion does not hold
- **THEN** the script prints `smoke: FAIL:` with that assertion's name and exits 1 without running later steps

#### Scenario: A dry run says what it skips
- **WHEN** `deploy/smoke.sh --dry-run` runs
- **THEN** every assertion's command is followed by `smoke: skip: <its name> (dry run: nothing is executed)`, except the three real-agent assertions, which print `smoke: skip: <its name> (needs --real-agent)` with no command, and stderr stays empty

### Requirement: Smoke test options
Besides `--dry-run`, `deploy/smoke.sh` SHALL accept three options. `--fresh` saves the current kubectl context, deletes and recreates the kind cluster `KIND_CLUSTER` before the first step, and restores the saved context. Any other argument, or any other `--break` value, SHALL exit 2 with usage.

#### Scenario: Breaking the claim assertion
- **WHEN** `deploy/smoke.sh --break pvc` runs against a cluster
- **THEN** it prints `smoke: FAIL: drill: the daemon pod mounts no volume claim` and exits 1, and the Deployment carries no `data-smoke-break` volume afterwards

#### Scenario: Breaking the claimable set
- **WHEN** `deploy/smoke.sh --break claimable` runs against a cluster
- **THEN** it prints `smoke: FAIL: drill: claimable set unchanged (API)` and exits 1

#### Scenario: Breaking the restart reason
- **WHEN** `deploy/smoke.sh --break restart` runs against a cluster
- **THEN** `pg-restart: the daemon container restarted` passes, and the script prints `smoke: FAIL: pg-restart: the daemon exited because its Postgres session was lost` and exits 1

#### Scenario: Unknown break
- **WHEN** `deploy/smoke.sh --break nothing` runs
- **THEN** it prints usage to stderr and exits 2

#### Scenario: Refused key file
- **WHEN** `deploy/smoke.sh --real-agent` runs without a value, with a path that does not exist, or with a file under the repository root, with every tool stubbed out
- **THEN** it exits 2 with one line on stderr, and no tool was called

### Requirement: Deployment run id
The reference manifests SHALL set no fixed run id: neither `store.runId` in the ConfigMap nor `ORCH_RUN_ID` on the daemon. Each deployment SHALL get its id from its clone's origin (`REPO_URL`, with `git.pushIntegration` on). `deploy/smoke.sh` SHALL read the run id from `/v1/status`.

#### Scenario: Base manifest
- **WHEN** the base is rendered
- **THEN** the ConfigMap's `store` block is `{kind: postgres, flushDeadlineMs}` without `runId` or `url`, and the daemon container has no `ORCH_RUN_ID`

#### Scenario: Two deployments on one database
- **WHEN** two deployments of the manifest clone different repositories and use one Postgres database
- **THEN** their run ids differ, because each id is the hash of its own origin

#### Scenario: Two spellings of one origin
- **WHEN** one deployment's `REPO_URL` is `https://host/x.git` and a later one's is `https://host/x`, on one database, with no `store.runId` or `ORCH_RUN_ID`
- **THEN** they are two runs, as `deploy/README.md` states, and setting `store.runId` or `ORCH_RUN_ID` to one id makes them one

### Requirement: Smoke Postgres-restart drill
After the outage drill, `deploy/smoke.sh` SHALL record `latestSeq`, the claimable launches and task states, the daemon pod's uid and its restart count. It SHALL start following the daemon container's log into a file, and then delete the Postgres instance pod. The daemon SHALL be seen to exit before readiness is awaited, because the pod is still Ready just after the deletion.

#### Scenario: The daemon exits on the lost session
- **WHEN** the old Postgres pod is gone (`kubectl delete pod --wait=true` has returned, after CloudNativePG's smart shutdown)
- **THEN** within `PG_EXIT_TIMEOUT_S` (default 60) seconds the daemon container's restart count is above the recorded one

#### Scenario: The restart reason is the lost session
- **WHEN** the restart has been seen
- **THEN** the container's last termination read at that moment is exit code 1 with reason `Error`, and the last line the exited container logged (from the log followed since before the deletion, which ends when that container exits) is `store fatal: exiting` with `reason: fenced`; any other termination or last line, such as an out-of-memory kill, a probe kill or a clean SIGTERM shutdown, fails the assertion

#### Scenario: Ready again within a stated time
- **WHEN** the daemon has exited
- **THEN** within `PG_READY_TIMEOUT_S` (default 120) seconds of the old Postgres pod being gone, the daemon pod is Ready and `/readyz` answers 200 through a new port-forward

#### Scenario: Recovery has finished before the comparison
- **WHEN** `/readyz` answers 200 again under local access
- **THEN** within `STATUS_TIMEOUT_S` the events after the recorded sequence hold a `launch.reprepared` for every recorded claimable launch, exactly one each, and only then are the states compared

#### Scenario: Remote recovery keeps the parked launches
- **WHEN** `/readyz` answers 200 again under remote access
- **THEN** within `STATUS_TIMEOUT_S` `/v1/status` serves `latestSeq` at least the recorded sequence and a consistent claimable set, no `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` after the recorded sequence names a recorded claimable launch, no `launch.reprepared` follows it at all, and only then are the states compared

#### Scenario: Same state after the Postgres restart
- **WHEN** recovery has settled for every recorded claimable launch
- **THEN** the daemon pod's uid is the recorded one, and the claimable launches (launch id and task id from the API; launch id, task id and token md5 from `psql`) and the task states from both equal the recorded ones

#### Scenario: The parked launch keeps its id and token
- **WHEN** all three drills have passed
- **THEN** a claim of `SMOKE-PARKED` returns a launch id and a token whose md5 match a claimable launch recorded before the first restart, and the script releases that launch again

### Requirement: Worker Deployment
`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `replicas: 0`, whose pods carry the label `app.kubernetes.io/name: orchestrator-worker` (so no selector of the daemon matches them) and run as uid and gid 1000 with `fsGroup` 1000. It SHALL have no volume claim. The base names no agent.

#### Scenario: Worker Deployment rendered
- **WHEN** `kubectl kustomize deploy/base` or `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output holds Deployment `orchestrator-worker` with `replicas: 0`, command `orchestrator-worker`, `POD_NAME` from `metadata.name`, `ORCH_API` at the daemon Service, and an `emptyDir` at the clone cache; only the kind overlay sets `ORCH_WORKER_AGENT=scripted`, and `test/host/deploy.test.ts` asserts each of these

#### Scenario: Worker termination grace period
- **WHEN** `kubectl kustomize deploy/base` or `kubectl kustomize deploy/overlays/kind` runs
- **THEN** Deployment `orchestrator-worker` has `terminationGracePeriodSeconds: 120` and its container has no `lifecycle`, and `test/host/worker-termination.test.ts` asserts both

### Requirement: Smoke M3 step
After the last drill assertion, `deploy/smoke.sh` SHALL scale `orchestrator-worker` to 2, wait for its rollout, and follow each worker pod's log into a file from its first line, because a worker exits once the run is finished and its restarted container would hide the log. It SHALL then assert, with these names:
- `M3: the run is finished`: within `FINISH_TIMEOUT_S` (default 600) seconds, `/v1/status` `finished` is `true`.

#### Scenario: Workers finish the run
- **WHEN** `deploy/smoke.sh --fresh` runs against the kind cluster
- **THEN** it prints `smoke: pass:` for the three M3 assertions after the drills and ends with `smoke: ok`

#### Scenario: Dry run lists the M3 assertions
- **WHEN** `deploy/smoke.sh --dry-run` runs
- **THEN** it lists every assertion name it listed before, plus the three M3 names, each followed by its skip line

## ADDED Requirements

### Requirement: Bind host and advertised URL: where the advertised URL is used
The advertised URL SHALL be the one stored in kv and `daemon.json`, embedded in briefs, returned by claims, and reported by `status`.

#### Scenario: Claim and brief name the advertised URL
- **WHEN** a daemon started with `apiBind: 0.0.0.0` and `apiBaseUrl: http://orchestrator:8080` answers a claim
- **THEN** the claim's `apiUrl` is `http://orchestrator:8080`, the brief's `brief.md` names `http://orchestrator:8080/v1/launches/` and does not contain `127.0.0.1`, and its `brief.json` has `apiBaseUrl` `http://orchestrator:8080`

### Requirement: Bind host and advertised URL: file keys only
`apiBind` and `apiBaseUrl` SHALL be file keys only: they are read at start and SHALL NOT be in the runtime override set, so `configure` and `PUT /v1/config` do not accept them.

#### Scenario: A runtime override naming the bind key is refused
- **WHEN** an override patch `{ apiBind: "0.0.0.0" }` or `{ apiBaseUrl: "http://x:8080" }` is applied, as `configure` and `PUT /v1/config` apply theirs, or given as `--set apiBind=0.0.0.0`
- **THEN** it is refused naming that key, because the override schema is strict and `OVERRIDABLE_KEYS` lists neither `apiBind` nor `apiBaseUrl`

### Requirement: Probes: journaled store readiness
A journaled store SHALL NOT be ready while its lag has been above zero for longer than one flush retry, and once its run lock is lost.

#### Scenario: Lag past one flush retry, then a lost lock
- **WHEN** a journaled store whose flush retry is 50 ms has one batch unflushed for 80 ms, the batch then lands, and the sink then reports its run lock lost
- **THEN** its readiness first names `1 batches unflushed for <n>ms, longer than one flush retry (50ms)`, is empty once the batch has landed, and then reads `store: the session holding the run lock was lost`, and `/readyz` adds these reasons to its own

### Requirement: Probes: no token and no idle activity
Neither `/healthz` nor `/readyz` SHALL require a token, and neither SHALL count as activity for the idle exit.

#### Scenario: Probes on the bound address without a token
- **WHEN** a daemon bound to `0.0.0.0` is asked `GET /healthz` and `GET /readyz` on a non-loopback address of the host, with no `Authorization` header
- **THEN** `/healthz` answers `{ ok: true }` and `/readyz` answers 200 `{ ok: true }`

### Requirement: Daemon image: no project toolchain
The `Dockerfile`'s final stage SHALL carry no project toolchain beyond Node; workers and verifiers get their own images.

#### Scenario: Only git, SSH and certificates are installed
- **WHEN** `test/host/docker.test.ts` reads the final stage of the `Dockerfile`
- **THEN** it finds one `apt-get install`, and every package it names is `git`, `openssh-client` or `ca-certificates`

### Requirement: Daemon image: build context
A `.dockerignore` SHALL keep `node_modules`, `dist`, `.git`, run data, SQLite files, test fixtures, and the plugin's `node_modules` out of the build context.

#### Scenario: Local state stays out of the build context
- **WHEN** `test/host/docker.test.ts` reads `.dockerignore`
- **THEN** its lines include `node_modules`, `dist`, `.git`, `.orchestrator-run` and `test/fixtures`

### Requirement: Daemon image: deploy notes
`deploy/README.md` SHALL name the image, the build command, and the three entrypoints.

#### Scenario: The notes name the image and how to build it
- **WHEN** `test/host/docker.test.ts` reads `deploy/README.md`
- **THEN** it contains `orchestrator:dev`, the command `docker build -t orchestrator:dev .`, and the entrypoint names `orchestrator` and `orchestrator-ctl`, each in backticks

### Requirement: Reference manifests: base ConfigMap
`deploy/base` SHALL be a kustomization rendering a hash-suffixed ConfigMap `orchestrator-config` holding only `orchestrator.yaml` (`runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl` naming the Service, `store.kind: postgres`, `store.urlFile: /var/run/secrets/orchestrator/postgres/uri`, `git.pushIntegration: true`).

#### Scenario: The ConfigMap's one file
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** ConfigMap `orchestrator-config` holds only the key `orchestrator.yaml`, which sets `runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl: http://orchestrator.orch.svc:8080`, `store` `{ kind: postgres, urlFile: /var/run/secrets/orchestrator/postgres/uri, flushDeadlineMs: 120000 }` and `git.pushIntegration: true`, and no `graphPath`

### Requirement: Reference manifests: daemon Deployment
`deploy/base` SHALL be a kustomization rendering a Deployment `orchestrator` with strategy `Recreate`, an `emptyDir` at `/data` and no volume claim, an init container `clone` that clones `REPO_URL` into `/data/repo`, a daemon container running `orchestrator --repo /data/repo` with `ORCH_HOME=/data/home` and `ORCH_LOG_FORMAT=json`, the ConfigMap's file mounted into the clone with `subPath`, and probes on `/healthz` and `/readyz`. The run lock, not the strategy, prevents two writers.

#### Scenario: Recreate on an emptyDir with a clone
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** Deployment `orchestrator` has strategy `Recreate`, an `emptyDir` volume `data` and no `persistentVolumeClaim` volume, an init container whose command runs `git clone "$REPO_URL" /data/repo`, and a daemon container with command `orchestrator --repo /data/repo`, `ORCH_LOG_FORMAT=json`, mounts at `/data` and `/data/repo/orchestrator.yaml`, a liveness probe on `/healthz` and a readiness probe on `/readyz`

### Requirement: Reference manifests: store URL file
`deploy/base` SHALL be a kustomization rendering a Deployment `orchestrator` with the Secret `postgres-app` key `uri` mounted read-only as the file `uri` under `/var/run/secrets/orchestrator/postgres` (mode 0440, readable through the pod's `fsGroup`), no `DATABASE_URL`, no `DATABASE_URL_FILE`, no variable starting with `PG` and no variable read from a Secret.

#### Scenario: The store URL is a mounted file
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the daemon container mounts `/var/run/secrets/orchestrator/postgres` read-only from a `secret` volume of `postgres-app` with `defaultMode` 0440 and the one item `uri`, and its environment has no `DATABASE_URL`, no `DATABASE_URL_FILE`, no name starting with `PG`, no `valueFrom` and no `envFrom`

### Requirement: Reference manifests: kind overlay origin
`deploy/overlays/kind` SHALL add a `git-origin` serving a bare repository seeded from `fixture/` with `receive-pack` enabled, and SHALL patch `REPO_URL` to it.

#### Scenario: git-origin serves pushes and is the clone's origin
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** it adds ConfigMap `git-origin-fixture`, Deployment `git-origin` running `git daemon --enable=receive-pack --base-path=/srv/git`, a claim `git-origin-data` and Service `git-origin` on port 9418, and the daemon's init container has `REPO_URL` `git://git-origin.orch.svc:9418/fixture.git`

### Requirement: Reference manifests: kind overlay remote run
`deploy/overlays/kind` SHALL make the run remote: its own `orchestrator.yaml` replaces the base file in `orchestrator-config` (`behavior: replace`), holding every base key plus `runner.access: remote`, `git.workerOriginUrl` set to the `git-origin` Service URL, and `capacity: 3` (so every dependant of `SMOKE` is parked before the drills), and a patch sets `ORCH_WORKER_AGENT=scripted` on `orchestrator-worker`.

#### Scenario: The overlay's file is the base file plus the remote keys
- **WHEN** `test/host/deploy.test.ts` compares the `orchestrator.yaml` of `deploy/overlays/kind` with that of `deploy/base`
- **THEN** the overlay's file has `runner.access: remote`, `git.workerOriginUrl` equal to the init container's `REPO_URL`, and `capacity: 3`, the base file has no `runner.access`, and with those three keys taken out the two files are equal

### Requirement: Reference manifests: fixture union merge
The fixture SHALL carry a `.gitattributes` with `README.md merge=union`, seeded with the other fixture files, so concurrent smoke tasks that each append a line to `README.md` rebase onto one another without a conflict.

#### Scenario: The attributes file reaches the seeded repository
- **WHEN** the kind overlay seeds `git-origin`'s bare repository from `fixture/`
- **THEN** `deploy/overlays/kind/fixture/.gitattributes` holds `README.md merge=union`, the overlay's `configMapGenerator` lists `fixture/.gitattributes`, and the seeding command in `deploy/overlays/kind/git-origin.yaml` copies `/fixture/.gitattributes` by name beside `/fixture/*`

### Requirement: Smoke test: port-forward, graph upload and M1 poll
`deploy/smoke.sh` SHALL in order: port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses. M1 asserts pull mode and a claimable launch.

#### Scenario: The forward, the graph and the first poll follow the waits
- **WHEN** `deploy/smoke.sh --dry-run` runs with every tool stubbed out
- **THEN** the port-forward to `service/orchestrator`, the retried `/healthz` call, `put_graph` and the `M1: pull mode with a claimable launch` poll of `/v1/status` with `STATUS_TIMEOUT_S` come after the rollout wait of `deployment/orchestrator`, in that order, and the poll holds when `runner.mode` is `pull` and `claimable` is not empty

### Requirement: Smoke test: kubectl context pinned
Every `kubectl` call that talks to a cluster SHALL pass `--context "$KUBE_CONTEXT"`. `KUBE_CONTEXT` defaults to `kind-$KIND_CLUSTER`; any other value SHALL exit 2 before any step.

#### Scenario: The default context follows the cluster name
- **WHEN** `deploy/smoke.sh` starts with `KIND_CLUSTER=dev` and no `KUBE_CONTEXT`
- **THEN** `KUBE_CONTEXT` is `kind-dev`, and the `kc` helper and every step that talks to the cluster run `kubectl --context kind-dev`

### Requirement: Smoke test: kubectl context restored
`deploy/smoke.sh` SHALL leave the current kubectl context as it found it. Under `--fresh`, `kind create cluster` changes the current kubectl context, so `deploy/smoke.sh` SHALL restore the previous context, or unset it if none was set, with `kubectl config` calls that carry no `--context`.

#### Scenario: The context is saved before the cluster is recreated
- **WHEN** `deploy/smoke.sh --dry-run --fresh` runs
- **THEN** it prints `save_context`, `kind delete cluster --name orch`, `kind create cluster --name orch` and `restore_context` in that order, before the `docker build` step

### Requirement: Smoke test: arguments
The accepted arguments are `--dry-run`, `--fresh`, `--break pvc|claimable|restart` and `--real-agent <key file>` (see "Smoke test options"); `--dry-run` SHALL print each step, execute nothing, and exit 0; any other argument SHALL exit 2 with usage.

#### Scenario: A dry run executes nothing
- **WHEN** `deploy/smoke.sh --dry-run` runs with every tool stubbed out
- **THEN** it prints each step's command, no stubbed tool is called, and it exits 0

### Requirement: Smoke test: M3 and M4 steps
M3 SHALL scale the worker Deployment and SHALL assert that the workers finish the run (see "Smoke M3 step"). M4 SHALL check the Claude worker image, a worker pod deleted mid-task and the launch trailers (see "Smoke M4 step"), and with `--real-agent` SHALL run the real-agent step last (see "Smoke real-agent step").

#### Scenario: Dry run order of the M3 and M4 steps
- **WHEN** `deploy/smoke.sh --dry-run` runs without `--real-agent`
- **THEN** the M4 block A assertions come after the final claim of `SMOKE-PARKED` and before the scale of `orchestrator-worker` to 2, the three M3 assertions follow that scale, and the M4 block B assertion and the three real-agent skip lines come after them

### Requirement: Smoke worker step: smoke graph
The kind overlay's graph SHALL hold one ready task, `SMOKE`, and three independent tasks that depend on it: `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`.

#### Scenario: One ready task and three dependants
- **WHEN** `deploy/overlays/kind/graph.yaml` is read
- **THEN** it has the nodes `SMOKE` with no dependency and `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`, each with `deps: [SMOKE]`

### Requirement: Smoke worker step: waits before the drills
After the worker step, `deploy/smoke.sh` SHALL wait until `SMOKE` is done and `SMOKE-PARKED` is claimable, and then until `SMOKE-M3-A` and `SMOKE-M3-B` are claimable too, so the claimable set does not change during the drills.

#### Scenario: Every dependant is parked before the snapshot
- **WHEN** the worker step has run
- **THEN** `drill: SMOKE published` waits up to `PUBLISH_TIMEOUT_S` for `SMOKE` in `byStatus.done`, `drill: SMOKE-PARKED claimable` waits up to `STATUS_TIMEOUT_S`, and a step then waits until none of `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B` is missing from `claimable`, before the restart drill records its snapshot

### Requirement: Smoke worker step: remote claims only
No claim `deploy/smoke.sh` makes SHALL be a local one: the outage drill's pending write, `--break claimable` and the final claim of `SMOKE-PARKED` all claim with `access: remote`.

#### Scenario: Each claim the script sends names remote access
- **WHEN** `deploy/smoke.sh` sends `POST /v1/claims` for the outage drill's pending write, for `--break claimable` and for the final claim of `SMOKE-PARKED`
- **THEN** each request body carries `"access":"remote"`

### Requirement: Smoke restart drill: claimable launch ids from events
The API lists claimable launches by task only, so their launch ids SHALL be read from the launch events: a launch is claimable when its latest `launch.claimable`, `launch.claimed`, `launch.released`, `launch.ended`, `launch.revoked` or `launch.failed` event is `launch.claimable`, and those launches' tasks SHALL equal `/v1/status` `claimable`.

#### Scenario: Events and status disagree
- **WHEN** the launch events name a claimable launch whose task `/v1/status` `claimable` does not list, or the other way round
- **THEN** `api_claimable` prints both lists to stderr and fails, so any assertion that compares the claimable launches fails

### Requirement: Smoke restart drill: wait for startup recovery
After the rollout `deploy/smoke.sh` SHALL wait until startup recovery has handled every recorded claimable launch, because `/readyz` passes before recovery runs, and only then SHALL it assert the scenarios of "Smoke restart drill". Under local access, handled means a `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event for that launch after the recorded sequence.

#### Scenario: A launch recovery has not handled yet holds the comparison back
- **WHEN** under local access a recorded claimable launch has no `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event after the recorded sequence
- **THEN** `drill: startup recovery settled every recorded claimable launch` keeps retrying, for at most `STATUS_TIMEOUT_S`, and `drill: claimable set unchanged (API)` and the other comparisons run only after it has passed

### Requirement: Smoke restart drill: run access
`deploy/smoke.sh` SHALL read the run's access from the kind overlay's `orchestrator.yaml` (`runner.access`, `remote` in the kind overlay).

#### Scenario: Access read from the overlay
- **WHEN** `deploy/smoke.sh` starts
- **THEN** it sets its run access to the value of the first `access:` line indented by two spaces in `deploy/overlays/kind/orchestrator.yaml` (`runner.access`, which is `remote` there), and to `local` when the file has no such line

### Requirement: Smoke restart drill: remote recovery settled
Under remote access, `drill: startup recovery settled every recorded claimable launch` SHALL wait until `/readyz` passes, `/v1/status` `latestSeq` is at least the recorded sequence and the claimable set reads consistently from the events and `/v1/status`, and SHALL fail if any `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event after the recorded sequence names a recorded claimable launch.

#### Scenario: Recovery records an event for a remote parked launch
- **WHEN** under remote access an event `launch.ended` after the recorded sequence names a recorded claimable launch
- **THEN** the settle check prints `remote run: recovery recorded an event for the parked launch <id> after seq <n>` and fails for that try, and `drill: startup recovery settled every recorded claimable launch` fails once `STATUS_TIMEOUT_S` has passed

### Requirement: Smoke restart drill: remote parked launch kept
Under remote access, startup recovery SHALL keep a remote parked launch as it is (it has no worktree on the daemon to prepare again) and SHALL record none of the `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` events. The unchanged launch id and token assertions that follow `drill: startup recovery settled every recorded claimable launch` carry the proof that each recorded launch is still parked.

#### Scenario: The proof that a remote launch is still parked
- **WHEN** the settle check has passed under remote access
- **THEN** `drill: claimable set unchanged (API)` compares launch id and task id with the recorded ones, and `drill: claimable set unchanged (psql)` compares launch id, task id and token md5 with the recorded ones

### Requirement: Smoke assertions are named: dry run
Under `--dry-run`, an assertion SHALL print its command and run nothing, except the three real-agent assertions, which without `--real-agent` print only `smoke: skip: <name> (needs --real-agent)`, in a dry run or not.

#### Scenario: Real-agent assertions skipped without the option
- **WHEN** `deploy/smoke.sh` runs without `--real-agent`, in a dry run or not
- **THEN** it prints `smoke: skip: M4: the real task is done (needs --real-agent)` and the same line for the other two real-agent names, and prints no command for any of the three

### Requirement: Smoke test options: break values
`--break pvc` creates a claim named `data-smoke-break`, mounts it into the daemon container by patching the Deployment, waits for that rollout's recovery, and only then records the restart-drill snapshot; on exit it removes the volume and mount from the Deployment and deletes the claim. `--break claimable` claims `SMOKE-PARKED`'s launch after the snapshot and before the restart. Each `--break` value SHALL fail its drill at its own named assertion, every assertion before it passing.

#### Scenario: Where each break happens
- **WHEN** `deploy/smoke.sh --dry-run --break pvc` and `deploy/smoke.sh --dry-run --break claimable` run
- **THEN** with `pvc` the steps `mount_break_claim` and `recovery_settled` come after the wait for `SMOKE-PARKED` and before the snapshot comparison `same  pg_claimable`; with `claimable` the claim of `SMOKE-PARKED` comes after that comparison and before the daemon pod is deleted

### Requirement: Smoke test options: break restart
`--break restart` SHALL send SIGTERM to the daemon process in place of deleting the Postgres pod, so the daemon's container restarts for a reason other than a lost session, and SHALL print a skip line for the deletion.

#### Scenario: SIGTERM in place of the Postgres pod deletion
- **WHEN** `deploy/smoke.sh --break restart` reaches the Postgres-restart drill
- **THEN** it prints `smoke: skip: delete_postgres_pod (--break restart stops the daemon instead)` and runs `kill -TERM 1` in the daemon container, and deletes no Postgres pod

### Requirement: Smoke test options: real agent
`--real-agent <key file>` takes one value, the path of a file outside the repository that holds the Anthropic key, and runs the real-agent step (see "Smoke real-agent step"); a missing value or a path that breaks its key file rule SHALL exit 2 with one line on stderr, before any step and any tool.

#### Scenario: A symbolic link is refused
- **WHEN** `deploy/smoke.sh --real-agent <link>` runs where `<link>` is a symbolic link to a file outside the repository, with every tool stubbed out
- **THEN** it exits 2 with one line on stderr and no usage, prints nothing on stdout, and no tool was called

### Requirement: Deployment run id: deploy notes
`deploy/README.md` SHALL state the order in which the id is chosen, its format, and when to set `store.runId` or `ORCH_RUN_ID`. It SHALL also state that an origin hash follows the URL as written apart from user information, give spellings of one repository that yield different run ids (with and without `.git`, with a trailing slash, scp-like against `ssh://`), and name `store.runId` and `ORCH_RUN_ID` as the way to pin the id.

#### Scenario: The notes list the order and the spellings
- **WHEN** a reader opens "The run id" in `deploy/README.md`
- **THEN** it lists the five sources of the id in order (`store.runId`, `ORCH_RUN_ID`, `git.originUrl`, the clone's `origin` with `git.pushIntegration: true`, the repository path), shows `https://git.example.com/team/project.git`, `https://git.example.com/team/project` and `https://git.example.com/team/project/` as three run ids, and says to pin the id with `store.runId` or `ORCH_RUN_ID`

### Requirement: Smoke Postgres-restart drill: parked briefs
Under local access a container restart keeps the pod's `emptyDir`, so startup recovery would leave the parked worktrees alone and record nothing; `deploy/smoke.sh` SHALL therefore remove `.orchestrator/brief.json` from each recorded claimable launch's worktree in the pod, so that recovery prepares each again and records `launch.reprepared`. Under remote access a parked launch has no worktree on the daemon, so the script removes nothing and says so.

#### Scenario: Briefs removed under local access, nothing under remote
- **WHEN** `remove_parked_briefs` runs with the recorded claimable launches
- **THEN** under local access it removes `<runDir>/worktrees/<launchId>/.orchestrator/brief.json` in the daemon container for each of them, and under remote access it prints `remote run: a parked launch has no worktree on the daemon; nothing to remove` and removes nothing

### Requirement: Smoke Postgres-restart drill: recovery assertions
The comparisons SHALL wait on conditions with timeouts, never on a fixed sleep. `pg-restart: startup recovery prepared every claimable launch again` and `pg-restart: one launch.reprepared per claimable launch` keep their names; under remote access they assert what recovery does for a remote parked launch, as `drill: startup recovery settled every recorded claimable launch` and `drill: one launch.reprepared per claimable launch` do (see "Smoke restart drill").

#### Scenario: The recovery assertions retry within a limit
- **WHEN** the Postgres-restart drill checks recovery
- **THEN** `pg-restart: startup recovery prepared every claimable launch again` runs the restart drill's settle check under `retry "$STATUS_TIMEOUT_S"` and `pg-restart: one launch.reprepared per claimable launch` runs its reprepared check, each with the access the script read, so under remote access they hold as the restart drill's two assertions do

### Requirement: Worker Deployment: termination
`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` whose pods set `terminationGracePeriodSeconds: 120` (the time the loop's hand-back on SIGTERM needs with every wait at its limit, see specs/worker-pool "Pod termination"), and hold one container on `orchestrator:dev` with command `orchestrator-worker` and no `lifecycle` (no preStop hook: the container's command is the loop, which gets the kubelet's SIGTERM itself).

#### Scenario: Grace period and container command in both renders
- **WHEN** `test/host/worker-termination.test.ts` renders `deploy/base` and `deploy/overlays/kind`
- **THEN** each Deployment `orchestrator-worker` has `terminationGracePeriodSeconds: 120`, and its one container runs `orchestrator-worker` and has no `lifecycle`

### Requirement: Worker Deployment: environment and clone cache
`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `POD_NAME` from `metadata.name` through the Downward API; `ORCH_API` set to the daemon Service URL `http://orchestrator.orch.svc:8080`; and an `emptyDir` mounted at the clone cache, `/var/cache/orchestrator` (`ORCH_WORKER_CACHE`).

#### Scenario: Worker id, API and cache
- **WHEN** `test/host/deploy.test.ts` renders `deploy/base`
- **THEN** the worker container's `POD_NAME` comes from `fieldRef` `metadata.name`, its `ORCH_API` is `http://orchestrator.orch.svc:8080`, built from the Service's name, namespace and port, and the volume mounted at its clone cache is an `emptyDir`

### Requirement: Worker Deployment: deploy notes
`deploy/README.md` SHALL describe the worker Deployment, `runner.access: remote`, `git.workerOriginUrl`, the termination on SIGTERM, and the M3 smoke step.

#### Scenario: The notes describe the worker pool
- **WHEN** a reader opens "The workers" in `deploy/README.md`
- **THEN** it describes the `orchestrator-worker` Deployment, says the daemon's `orchestrator.yaml` must set `runner.access: remote`, names `git.workerOriginUrl` and says what the loop does on SIGTERM, and the "Smoke test" section describes the M3 step

### Requirement: Smoke M3 step: integration branch assertion
`deploy/smoke.sh` SHALL then assert, with these names: `M3: every smoke task is on origin's integration branch`: the first-parent history of origin's `main` carries an `Orchestrator-Task` trailer for each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`.

#### Scenario: A task without a trailer on origin
- **WHEN** the first-parent history of origin's `main` has no `Orchestrator-Task` trailer for `SMOKE-M3-B`
- **THEN** the assertion prints `missing: SMOKE-M3-B` and `smoke: FAIL: M3: every smoke task is on origin's integration branch`, and the script exits 1

### Requirement: Smoke M3 step: worker log assertion
`deploy/smoke.sh` SHALL then assert, with these names: `M3: worker logs show one accepted report per task`: the log of `smoke-worker` and the followed worker logs together hold exactly one `worker <id> report accepted <launchId> <taskId>` line for each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`, and none for another task.

#### Scenario: Logs read once the followers end
- **WHEN** the M3 worker log assertion runs
- **THEN** it waits up to `PG_LOG_TIMEOUT_S` for every log follower to end, then counts the `worker <id> report accepted <launchId> <taskId>` lines of the `smoke-worker` pod's log and the followed logs by task, and holds only when the counts are `SMOKE=1`, `SMOKE-PARKED=1`, `SMOKE-M3-A=1` and `SMOKE-M3-B=1`
