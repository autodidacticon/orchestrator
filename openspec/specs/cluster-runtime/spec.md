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

### Requirement: Daemon image
The repository SHALL carry a multi-stage `Dockerfile` on `node:22-slim` whose build stage compiles `dist/` and whose final stage holds `git`, `openssh-client`, `ca-certificates`, the built `dist/src`, and production dependencies only, runs as the unprivileged `node` user, and puts `orchestrator` (the default command), `orchestrator-ctl` and `orchestrator-worker` (the remote worker loop, specs/worker-pool) on `PATH`. It SHALL carry no project toolchain beyond Node; workers and verifiers get their own images. A `.dockerignore` SHALL keep `node_modules`, `dist`, `.git`, run data, SQLite files, test fixtures, and the plugin's `node_modules` out of the build context. `deploy/README.md` SHALL name the image, the build command, and the three entrypoints.

#### Scenario: Image contents asserted without a Docker daemon
- **WHEN** `test/host/docker.test.ts` runs
- **THEN** it reads the Dockerfile and `.dockerignore` and asserts the base image, the two stages, the installed packages, the production-only install, the three entrypoints, and the ignored paths

#### Scenario: Entrypoints on PATH
- **WHEN** `docker run --rm orchestrator:dev orchestrator-ctl`, `docker run --rm orchestrator:dev orchestrator --help` and `docker run --rm orchestrator:dev orchestrator-worker --help` are run
- **THEN** each prints its usage

### Requirement: Reference manifests
`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a hash-suffixed ConfigMap `orchestrator-config` holding only `orchestrator.yaml` (`runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl` naming the Service, `store.kind: postgres`, `store.urlFile: /var/run/secrets/orchestrator/postgres/uri`, `git.pushIntegration: true`); a CloudNativePG `Cluster` `postgres`; a Deployment `orchestrator` with strategy `Recreate`, an `emptyDir` at `/data` and no volume claim, an init container `clone` that clones `REPO_URL` into `/data/repo`, a daemon container running `orchestrator --repo /data/repo` with `ORCH_HOME=/data/home` and `ORCH_LOG_FORMAT=json`, the Secret `postgres-app` key `uri` mounted read-only as the file `uri` under `/var/run/secrets/orchestrator/postgres` (mode 0440, readable through the pod's `fsGroup`), no `DATABASE_URL`, no `DATABASE_URL_FILE`, no variable starting with `PG` and no variable read from a Secret, the ConfigMap's file mounted into the clone with `subPath`, and probes on `/healthz` and `/readyz`; a ClusterIP Service `orchestrator` on port 8080; and the worker Deployment `orchestrator-worker` (see "Worker Deployment"). The run lock, not the strategy, prevents two writers. `deploy/overlays/kind` SHALL add a `git-origin` serving a bare repository seeded from `fixture/` with `receive-pack` enabled, SHALL patch `REPO_URL` to it, and SHALL make the run remote: its own `orchestrator.yaml` replaces the base file in `orchestrator-config` (`behavior: replace`), holding every base key plus `runner.access: remote`, `git.workerOriginUrl` set to the `git-origin` Service URL, and `capacity: 3` (so every dependant of `SMOKE` is parked before the drills), and a patch sets `ORCH_WORKER_AGENT=scripted` on `orchestrator-worker`. The fixture SHALL carry a `.gitattributes` with `README.md merge=union`, seeded with the other fixture files, so concurrent smoke tasks that each append a line to `README.md` rebase onto one another without a conflict.

#### Scenario: Base renders every resource
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the output holds the Namespace, the ConfigMap, the Postgres Cluster, the worker Deployment at `replicas: 0`, the Recreate Deployment on an `emptyDir` reading the store URL from the Secret mounted as a file and holding no store URL, password or libpq variable in its environment, and the Service, and no PersistentVolumeClaim

#### Scenario: Kind overlay supplies the origin and a ready task
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output adds `git-origin` and points `REPO_URL` at it; its `orchestrator.yaml` is the base file plus `runner.access: remote`, `git.workerOriginUrl: git://git-origin.orch.svc:9418/fixture.git` and `capacity: 3`; the worker Deployment carries `ORCH_WORKER_AGENT=scripted` and `replicas: 0`; the overlay's `graph.yaml` is not mounted, and it holds one ready task that the daemon parks as claimable once the smoke script sends it with `PUT /v1/graph`

### Requirement: Smoke test
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`, port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses. Every `kubectl` call that talks to a cluster SHALL pass `--context "$KUBE_CONTEXT"`. `KUBE_CONTEXT` defaults to `kind-$KIND_CLUSTER`; any other value SHALL exit 2 before any step. The script SHALL leave the current kubectl context as it found it. Under `--fresh`, `kind create cluster` changes it, so the script SHALL restore the previous context, or unset it if none was set, with `kubectl config` calls that carry no `--context`. The accepted arguments are `--dry-run`, `--fresh`, `--break pvc|claimable|restart` and `--real-agent <key file>` (see "Smoke test options"); `--dry-run` SHALL print each step, execute nothing, and exit 0; any other argument SHALL exit 2 with usage. M1 asserts pull mode and a claimable launch. M2 asserts that the daemon pod has no volume backed by a claim, then runs the restart, outage and Postgres-restart drills. M3 scales the worker Deployment and asserts that the workers finish the run (see "Smoke M3 step"). M4 checks the Claude worker image, a worker pod deleted mid-task and the launch trailers (see "Smoke M4 step"), and with `--real-agent` runs the real-agent step last (see "Smoke real-agent step").

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
The kind overlay's graph SHALL hold one ready task, `SMOKE`, and three independent tasks that depend on it: `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`. `deploy/smoke.sh` SHALL work `SMOKE` with one worker pod, `smoke-worker`: `orchestrator-worker` run with `ORCH_WORKER_AGENT=scripted`, `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`, which claims with `access: remote`, clones origin, commits on the launch branch, pushes it and submits with its sha. The step SHALL fail unless the pod exits with phase `Succeeded` and its log shows `report accepted` for `SMOKE`; the pod SHALL be kept for the M3 log assertion. The script SHALL then wait until `SMOKE` is done and `SMOKE-PARKED` is claimable, and then until `SMOKE-M3-A` and `SMOKE-M3-B` are claimable too, so the claimable set does not change during the drills. No claim the script makes SHALL be a local one: the outage drill's pending write, `--break claimable` and the final claim of `SMOKE-PARKED` all claim with `access: remote`.

#### Scenario: One published, one parked
- **WHEN** the worker step and the waits have passed
- **THEN** `/v1/status` lists `SMOKE` in `byStatus.done` and `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B` in `claimable`, and the `smoke-worker` pod has succeeded

#### Scenario: A rerun on a kept cluster
- **WHEN** the script runs again against a cluster whose run is unfinished and where `SMOKE` is already done
- **THEN** it skips the worker step, printing `smoke: skip: working SMOKE` with the reason, and runs the drill against the existing run

### Requirement: Smoke restart drill
Before deleting the daemon pod, `deploy/smoke.sh` SHALL record a snapshot. From the API it records the claimable launches as launch id and task id, the task states, `latestSeq`, the integration head (the `publishedSha` of `SMOKE`'s `transition` to `done`), and the daemon pod's uid. The API lists claimable launches by task only, so their launch ids SHALL be read from the launch events: a launch is claimable when its latest `launch.claimable`, `launch.claimed`, `launch.released`, `launch.ended`, `launch.revoked` or `launch.failed` event is `launch.claimable`, and those launches' tasks SHALL equal `/v1/status` `claimable`. Through `psql` on the CloudNativePG instance pod it records the run's launch counts by status, the claimable launches as launch id, task id and the md5 of the token, and the task states. The script reads the run's access from the kind overlay's `orchestrator.yaml` (`runner.access`, `remote` in the kind overlay). After the rollout it SHALL wait until startup recovery has handled every recorded claimable launch, because `/readyz` passes before recovery runs, and only then SHALL it assert the scenarios below. Under local access, handled means a `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event for that launch after the recorded sequence. Under remote access, startup recovery keeps a remote parked launch as it is (it has no worktree on the daemon to prepare again) and records none of those events, so `drill: startup recovery settled every recorded claimable launch` SHALL wait until `/readyz` passes, `/v1/status` `latestSeq` is at least the recorded sequence and the claimable set reads consistently from the events and `/v1/status`, and SHALL fail if any of those four events after the recorded sequence names a recorded claimable launch. The unchanged launch id and token assertions that follow carry the proof that each recorded launch is still parked.

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

### Requirement: Smoke Postgres-outage drill
After the restart drill, `deploy/smoke.sh` SHALL stop Postgres for `OUTAGE_S` seconds (default 10) without closing the daemon's session, keep one write pending meanwhile, and sample `/readyz` and `/v1/status` once a second. It SHALL NOT scale the cluster to zero, because the journal sink treats a lost session as fatal; a real Postgres restart is the Postgres-restart drill.

#### Scenario: Postgres is frozen, not removed
- **WHEN** the outage drill starts
- **THEN** every `postgres` process of the instance pod receives SIGSTOP, and SIGCONT after `OUTAGE_S` seconds or on exit, staying under CloudNativePG's liveness window of about 30s

#### Scenario: A write is pending
- **WHEN** the last sample has been taken and Postgres is still stopped
- **THEN** the `POST /v1/claims` for a task that does not exist is still running and has answered nothing, and `storePendingBatches` is above zero

#### Scenario: Readiness fails, status answers
- **WHEN** Postgres is stopped
- **THEN** every `/readyz` sample answers 200 or 503, at least one answers 503 (no answer, `000`, does not count), every `/v1/status` sample answers, and `storeLagMs` is above zero at the first sample and rises at every later one

#### Scenario: Recovery without a restart
- **WHEN** Postgres is resumed
- **THEN** `storeLagMs` and `storePendingBatches` return to zero, `/readyz` answers 200, the pending write answers 404, and the daemon pod's uid and container restart count equal the ones recorded before the outage

### Requirement: Smoke assertions are named
Every assertion in `deploy/smoke.sh` SHALL print `smoke: pass: <name>` when it holds. The first assertion that does not hold SHALL print `smoke: FAIL: <name>` to stderr, and the script SHALL exit 1. A full pass SHALL end with `smoke: ok`. Under `--dry-run`, an assertion SHALL print its command and run nothing, except the three real-agent assertions, which without `--real-agent` print only `smoke: skip: <name> (needs --real-agent)`, in a dry run or not. No assertion or step SHALL be skipped silently: one that does not run SHALL print `smoke: skip: <name> (<why>)` on stdout. No environment variable SHALL turn an assertion off.

#### Scenario: A false assertion fails the run
- **WHEN** a restart-drill assertion does not hold
- **THEN** the script prints `smoke: FAIL:` with that assertion's name and exits 1 without running later steps

#### Scenario: A dry run says what it skips
- **WHEN** `deploy/smoke.sh --dry-run` runs
- **THEN** every assertion's command is followed by `smoke: skip: <its name> (dry run: nothing is executed)`, except the three real-agent assertions, which print `smoke: skip: <its name> (needs --real-agent)` with no command, and stderr stays empty

### Requirement: Smoke test options
Besides `--dry-run`, `deploy/smoke.sh` SHALL accept three options. `--fresh` saves the current kubectl context, deletes and recreates the kind cluster `KIND_CLUSTER` before the first step, and restores the saved context. `--break pvc` creates a claim named `data-smoke-break`, mounts it into the daemon container by patching the Deployment, waits for that rollout's recovery, and only then records the restart-drill snapshot; on exit it removes the volume and mount from the Deployment and deletes the claim. `--break claimable` claims `SMOKE-PARKED`'s launch after the snapshot and before the restart. `--break restart` sends SIGTERM to the daemon process in place of deleting the Postgres pod, so the daemon's container restarts for a reason other than a lost session, and prints a skip line for the deletion. Each `--break` value SHALL fail its drill at its own named assertion, every assertion before it passing. `--real-agent <key file>` takes one value, the path of a file outside the repository that holds the Anthropic key, and runs the real-agent step (see "Smoke real-agent step"); a missing value or a path that breaks its key file rule SHALL exit 2 with one line on stderr, before any step and any tool. Any other argument, or any other `--break` value, SHALL exit 2 with usage.

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
The reference manifests SHALL set no fixed run id: neither `store.runId` in the ConfigMap nor `ORCH_RUN_ID` on the daemon. Each deployment SHALL get its id from its clone's origin (`REPO_URL`, with `git.pushIntegration` on). `deploy/README.md` SHALL state the order in which the id is chosen, its format, and when to set `store.runId` or `ORCH_RUN_ID`. It SHALL also state that an origin hash follows the URL as written apart from user information, give spellings of one repository that yield different run ids (with and without `.git`, with a trailing slash, scp-like against `ssh://`), and name `store.runId` and `ORCH_RUN_ID` as the way to pin the id. `deploy/smoke.sh` SHALL read the run id from `/v1/status`.

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
After the outage drill, `deploy/smoke.sh` SHALL record `latestSeq`, the claimable launches and task states, the daemon pod's uid and its restart count. Under local access a container restart keeps the pod's `emptyDir`, so startup recovery would leave the parked worktrees alone and record nothing; the script SHALL therefore remove `.orchestrator/brief.json` from each recorded claimable launch's worktree in the pod, so that recovery prepares each again and records `launch.reprepared`. Under remote access a parked launch has no worktree on the daemon, so the script removes nothing and says so. It SHALL start following the daemon container's log into a file, and then delete the Postgres instance pod. The daemon SHALL be seen to exit before readiness is awaited, because the pod is still Ready just after the deletion. The comparisons SHALL wait on conditions with timeouts, never on a fixed sleep. `pg-restart: startup recovery prepared every claimable launch again` and `pg-restart: one launch.reprepared per claimable launch` keep their names; under remote access they assert what recovery does for a remote parked launch, as `drill: startup recovery settled every recorded claimable launch` and `drill: one launch.reprepared per claimable launch` do (see "Smoke restart drill").

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

### Requirement: Deploy notes state who the layout is for

`deploy/README.md` SHALL state, in a section before the image section, that the reference manifests are a single-user preview on kind, that the API takes no credential except the launch token, who reaches the API in the reference manifests, and that the Service is not to be exposed. It SHALL name the hardening milestone as the place authentication comes from.

#### Scenario: A reader looks for the API's exposure

- **WHEN** a reader opens `deploy/README.md`
- **THEN** a section before "Daemon image" says the layout is a single-user preview on kind, that only the six routes a worker calls read a credential (the launch token), that every pod in the cluster and every user who may port-forward into namespace `orch` reaches the API, that the Service must not be exposed through an Ingress, a NodePort or a LoadBalancer, and that authentication comes with the hardening milestone

### Requirement: Worker Deployment
`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `replicas: 0`, whose pods carry the label `app.kubernetes.io/name: orchestrator-worker` (so no selector of the daemon matches them), run as uid and gid 1000 with `fsGroup` 1000, set `terminationGracePeriodSeconds: 120` (the time the loop's hand-back on SIGTERM needs with every wait at its limit, see specs/worker-pool "Pod termination"), and hold one container on `orchestrator:dev` with command `orchestrator-worker` and no `lifecycle` (no preStop hook: the container's command is the loop, which gets the kubelet's SIGTERM itself); `POD_NAME` from `metadata.name` through the Downward API; `ORCH_API` set to the daemon Service URL `http://orchestrator.orch.svc:8080`; and an `emptyDir` mounted at the clone cache, `/var/cache/orchestrator` (`ORCH_WORKER_CACHE`). It SHALL have no volume claim. The base names no agent. `deploy/README.md` SHALL describe the worker Deployment, `runner.access: remote`, `git.workerOriginUrl`, the termination on SIGTERM, and the M3 smoke step.

#### Scenario: Worker Deployment rendered
- **WHEN** `kubectl kustomize deploy/base` or `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output holds Deployment `orchestrator-worker` with `replicas: 0`, command `orchestrator-worker`, `POD_NAME` from `metadata.name`, `ORCH_API` at the daemon Service, and an `emptyDir` at the clone cache; only the kind overlay sets `ORCH_WORKER_AGENT=scripted`, and `test/host/deploy.test.ts` asserts each of these

#### Scenario: Worker termination grace period
- **WHEN** `kubectl kustomize deploy/base` or `kubectl kustomize deploy/overlays/kind` runs
- **THEN** Deployment `orchestrator-worker` has `terminationGracePeriodSeconds: 120` and its container has no `lifecycle`, and `test/host/worker-termination.test.ts` asserts both

### Requirement: Smoke M3 step
After the last drill assertion, `deploy/smoke.sh` SHALL scale `orchestrator-worker` to 2, wait for its rollout, and follow each worker pod's log into a file from its first line, because a worker exits once the run is finished and its restarted container would hide the log. It SHALL then assert, with these names:
- `M3: the run is finished`: within `FINISH_TIMEOUT_S` (default 600) seconds, `/v1/status` `finished` is `true`;
- `M3: every smoke task is on origin's integration branch`: the first-parent history of origin's `main` carries an `Orchestrator-Task` trailer for each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`;
- `M3: worker logs show one accepted report per task`: the log of `smoke-worker` and the followed worker logs together hold exactly one `worker <id> report accepted <launchId> <taskId>` line for each of those four tasks, and none for another task.

#### Scenario: Workers finish the run
- **WHEN** `deploy/smoke.sh --fresh` runs against the kind cluster
- **THEN** it prints `smoke: pass:` for the three M3 assertions after the drills and ends with `smoke: ok`

#### Scenario: Dry run lists the M3 assertions
- **WHEN** `deploy/smoke.sh --dry-run` runs
- **THEN** it lists every assertion name it listed before, plus the three M3 names, each followed by its skip line

### Requirement: Claude worker image
The repository SHALL carry `deploy/worker-claude/Dockerfile`, the Claude worker image: one stage `FROM ${PROJECT_BASE}` (default `orchestrator:dev`) that installs the Claude Code CLI at the build argument `CLAUDE_CODE_VERSION`, whose default the Dockerfile sets, runs as `node` with command `orchestrator-worker`, and sets `ORCH_WORKER_COMMAND` to a Claude template the worker loop composes. The image SHALL hold no key for the model. The daemon's `Dockerfile` is not changed.

#### Scenario: Image asserted without a Docker daemon
- **WHEN** `test/host/worker-image.test.ts` reads `deploy/worker-claude/Dockerfile`
- **THEN** its first instruction is `ARG PROJECT_BASE=orchestrator:dev`, its only `FROM` is `${PROJECT_BASE}`, `ARG CLAUDE_CODE_VERSION` and `USER root` stand after the `FROM` and before the `RUN` that installs the CLI at that version, the last `USER` is `node`, `CMD` is the exec form `["orchestrator-worker"]`, and there is no `ENTRYPOINT`

#### Scenario: Command template without an allow list
- **WHEN** the worker loop composes the image's `ORCH_WORKER_COMMAND` for a claim
- **THEN** it reads `claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --dangerously-skip-permissions --model {model} --effort {effort} --no-session-persistence < {brief}` with every slot filled; it has no `{allowedTools}` slot, because a remote brief carries no allow list, so every tool call of the agent is allowed and the container is the boundary, and a deployment that wants `--permission-mode acceptEdits` with an allow list sets its own `ORCH_WORKER_COMMAND`

#### Scenario: Git identity, no self-update, no key
- **WHEN** the Dockerfile is read
- **THEN** it sets `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` to `orchestrator-worker`, `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` to `worker@orchestrator.local`, and `DISABLE_AUTOUPDATER=1`, and no line of it holds `ANTHROPIC_`

#### Scenario: A project layers its toolchain
- **WHEN** a project builds an image from `orchestrator:dev` that installs its toolchain and passes it as `PROJECT_BASE`
- **THEN** the worker image is built on that image, with the toolchain, the CLI and `orchestrator-worker`

#### Scenario: Deploy notes describe the image
- **WHEN** a reader opens `deploy/README.md`
- **THEN** a section "Claude worker image" names `orchestrator-worker-claude:dev` and the build command `docker build -f deploy/worker-claude/Dockerfile -t orchestrator-worker-claude:dev deploy/worker-claude`, says how a project layers its toolchain through `PROJECT_BASE`, names `CLAUDE_CODE_VERSION` as the build argument that fixes the CLI version and says that the Dockerfile sets its default, gives the command template and says that the agent runs with every tool call allowed, names the git identity, and says that the key is never in the image; "The workers" says that the shim's `report` tool pushes the branch and names `sealedSha`

### Requirement: Smoke M4 step
Between the final drill claim and the M3 scale-up, `deploy/smoke.sh` SHALL build and load the Claude worker image and assert `M4: the Claude worker image runs the claude CLI`, `M4: deleting the worker pod mid-task releases its launch with kept true` and `M4: usage printed by the terminated agent is recorded`. After the M3 assertions it SHALL assert `M4: every integration commit carries its Orchestrator-Launch trailer`.

#### Scenario: The image runs its CLI
- **WHEN** block A runs
- **THEN** the script builds `deploy/worker-claude/Dockerfile` as `WORKER_IMAGE` (default `orchestrator-worker-claude:dev`) with `PROJECT_BASE` set to `IMAGE`, loads it into the kind cluster, and a one-shot pod of `WORKER_IMAGE` runs `sh -c 'claude --version && test -w "$HOME"'`, the script prints its log, and the assertion holds when the pod succeeds with a non-empty log

#### Scenario: A worker pod deleted mid-task
- **WHEN** a one-shot pod `smoke-term` of `IMAGE` with `ORCH_WORKER_TASK=SMOKE-M3-A`, `ORCH_WORKER_MAX_LAUNCHES=1`, `ORCH_WORKER_AGENT=command` and a stand-in agent that appends a line to `README.md`, prints a Claude result object with token counts and `total_cost_usd` 0.01 on standard output, prints `smoke-term-ready` on standard error and sleeps, is deleted with `--grace-period=120` once its log shows the marker
- **THEN** the `launch.released` event of `SMOKE-M3-A` with `workerId` `smoke-term` has `kept: true`, `reason` `podTerminating` and a `headSha` that is a commit in git-origin's repository, and `/v1/status` `cost.byTask["SMOKE-M3-A"]` is above zero within `STATUS_TIMEOUT_S`

#### Scenario: The M3 step works the kept head
- **WHEN** both termination assertions have passed
- **THEN** the script waits until `SMOKE-M3-A` is claimable again, and the M3 step runs unchanged

#### Scenario: Rerun on a kept cluster
- **WHEN** after a leftover `smoke-term` pod is deleted `SMOKE-M3-A` has no claimable launch
- **THEN** the termination step and the wait are skipped, and both termination assertions print `smoke: skip: <name> (SMOKE-M3-A is not claimable)`

#### Scenario: A pass that fails mid-step
- **WHEN** the script exits while a `smoke-term` pod it started still exists
- **THEN** it deletes the pod and waits until it is gone, so the pod does not hold `SMOKE-M3-A`

#### Scenario: Launch trailers
- **WHEN** block B runs
- **THEN** every first-parent commit of origin's `main` with an `Orchestrator-Task` trailer has an `Orchestrator-Launch` trailer whose value is the `launchId` of an `agent.report` event of that task

### Requirement: Smoke real-agent step
With `--real-agent <key file>`, `deploy/smoke.sh` SHALL run the real-agent step as its last step: Claude workers holding the key work the added task `SMOKE-REAL`, and it asserts `M4: the real task is done` (within `REAL_TIMEOUT_S`, default 900), `M4: the real task's launch cost is above zero` and `M4: the real task's commit carries its Orchestrator-Launch trailer`. Without the option each of the three SHALL print `smoke: skip: <name> (needs --real-agent)`, in a dry run too.

#### Scenario: The key file rule
- **WHEN** `--real-agent` has no value, or names a path that is not a readable regular file, a symbolic link, or a file whose directory's physical path is the repository root or below it
- **THEN** the script prints one line on stderr and exits 2 before any step and before any tool is called; a relative path is read against the caller's working directory

#### Scenario: The steps
- **WHEN** `deploy/smoke.sh --dry-run --real-agent <file>` runs
- **THEN** after the M4 trailer assertion it lists the Secret step, the scale of `orchestrator-worker` to 0 and the wait for no worker pod, `apply -k deploy/overlays/kind-claude`, the upload of `graph.yaml` followed by `real-task.yaml`, the wait for `SMOKE-REAL` to be claimable, the scale to 1 and the three assertions, calls no tool, and does not read the file

#### Scenario: The key stays out of the output
- **WHEN** the real-agent step creates the Secret `anthropic-api-key` in namespace `orch`
- **THEN** its one key `ANTHROPIC_API_KEY` holds the file's content with line ends removed, the key reaches `kubectl` on standard input only, and the script prints the file's path, never the key

#### Scenario: Cost after the task is done
- **WHEN** `SMOKE-REAL` is done
- **THEN** `cost.byTask["SMOKE-REAL"]` is polled for `STATUS_TIMEOUT_S` seconds, because the worker posts usage after the agent has exited

#### Scenario: No agent after the script
- **WHEN** a run with `--real-agent` exits, whatever its outcome and unless it is a dry run
- **THEN** the script scales `orchestrator-worker` to 0, and the next smoke on that cluster is run with `--fresh`

#### Scenario: The last step
- **WHEN** a later milestone adds a smoke step
- **THEN** it goes above the real-agent step, which changes the worker pool, as a comment in the script says

### Requirement: Kind overlay for the Claude worker
The repository SHALL carry `deploy/overlays/kind-claude`: the kind overlay plus one strategic merge patch on `orchestrator-worker` that sets the image `orchestrator-worker-claude:dev`, `ORCH_WORKER_AGENT=command`, and `ANTHROPIC_API_KEY` from the Secret `anthropic-api-key`, key `ANTHROPIC_API_KEY`. It SHALL render no Secret and no `ORCH_WORKER_COMMAND`, and leave every other resource of the kind overlay as it is.

#### Scenario: Rendered overlay
- **WHEN** `test/host/real-agent-overlay.test.ts` renders `deploy/overlays/kind-claude` with `kubectl kustomize`
- **THEN** `orchestrator-worker` has that image, `replicas: 0`, `ORCH_WORKER_AGENT` `command`, no `ORCH_WORKER_COMMAND`, and `ANTHROPIC_API_KEY` from that `secretKeyRef` with no literal value; no Secret is rendered, and every other resource equals the kind overlay's

#### Scenario: The real task
- **WHEN** `deploy/overlays/kind/graph.yaml` followed by `deploy/overlays/kind-claude/real-task.yaml` is parsed as one graph
- **THEN** its only new node is `SMOKE-REAL`, with `deps` `[SMOKE]`, a non-empty `description`, one acceptance criterion and no `model`, and `SlotValidator` accepts it, so the daemon does not block it with `insufficientSpec`

### Requirement: Smoke finished-run check
A run of `deploy/smoke.sh` without `--fresh` SHALL first read `/v1/status` of the kept cluster's daemon through the API server's Service proxy, `/api/v1/namespaces/orch/services/orchestrator:api/proxy/v1/status`, after every argument is checked and before any other step. When it answers `finished: true`, the script SHALL print one line on stderr that names `--fresh` and exit 2, having changed nothing on the cluster.

#### Scenario: A finished run is refused
- **WHEN** `deploy/smoke.sh` runs without `--fresh` against a cluster whose `/v1/status` answers `finished: true`
- **THEN** it prints one line on stderr that names `--fresh`, exits 2, and makes no `docker`, `kind` or `kubectl apply` call; the status read is its only `kubectl` call, and its EXIT cleanup does not run, so `--real-agent` scales nothing

#### Scenario: No answer or an unfinished run goes on
- **WHEN** the status read fails (no cluster, namespace or daemon) or answers a `finished` that is not `true`
- **THEN** the script goes on to the image build

#### Scenario: Fresh and dry runs
- **WHEN** the script runs with `--fresh`, or with `--dry-run`
- **THEN** with `--fresh` the check does not run and the script prints `smoke: skip: finished-run check (--fresh starts a new cluster)`; with `--dry-run` and without `--fresh` it prints `+ finished_run_check` as its first step and does not run it
