## ADDED Requirements

### Requirement: Worker Deployment
`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `replicas: 0`, whose pods carry the label `app.kubernetes.io/name: orchestrator-worker` (so no selector of the daemon matches them), run as uid and gid 1000 with `fsGroup` 1000, and hold one container on `orchestrator:dev` with command `orchestrator-worker`; `POD_NAME` from `metadata.name` through the Downward API; `ORCH_API` set to the daemon Service URL `http://orchestrator.orch.svc:8080`; and an `emptyDir` mounted at the clone cache, `/var/cache/orchestrator` (`ORCH_WORKER_CACHE`). It SHALL have no volume claim. The base names no agent. `deploy/README.md` SHALL describe the worker Deployment, `runner.access: remote`, `git.workerOriginUrl`, and the M3 smoke step.

#### Scenario: Worker Deployment rendered
- **WHEN** `kubectl kustomize deploy/base` or `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output holds Deployment `orchestrator-worker` with `replicas: 0`, command `orchestrator-worker`, `POD_NAME` from `metadata.name`, `ORCH_API` at the daemon Service, and an `emptyDir` at the clone cache; only the kind overlay sets `ORCH_WORKER_AGENT=scripted`, and `test/host/deploy.test.ts` asserts each of these

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

## MODIFIED Requirements

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
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`, port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses. Every `kubectl` call that talks to a cluster SHALL pass `--context "$KUBE_CONTEXT"`. `KUBE_CONTEXT` defaults to `kind-$KIND_CLUSTER`; any other value SHALL exit 2 before any step. The script SHALL leave the current kubectl context as it found it. Under `--fresh`, `kind create cluster` changes it, so the script SHALL restore the previous context, or unset it if none was set, with `kubectl config` calls that carry no `--context`. The accepted arguments are `--dry-run`, `--fresh` and `--break pvc|claimable|restart` (see "Smoke test options"); `--dry-run` SHALL print each step, execute nothing, and exit 0; any other argument SHALL exit 2 with usage. M1 asserts pull mode and a claimable launch. M2 asserts that the daemon pod has no volume backed by a claim, then runs the restart, outage and Postgres-restart drills. M3 scales the worker Deployment and asserts that the workers finish the run (see "Smoke M3 step").

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

### Requirement: Smoke worker step
The kind overlay's graph SHALL hold one ready task, `SMOKE`, and three independent tasks that depend on it: `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`. `deploy/smoke.sh` SHALL work `SMOKE` with one worker pod, `smoke-worker`: `orchestrator-worker` run with `ORCH_WORKER_AGENT=scripted`, `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`, which claims with `access: remote`, clones origin, commits on the launch branch, pushes it and submits with its sha. The step SHALL fail unless the pod exits with phase `Succeeded` and its log shows `report accepted` for `SMOKE`; the pod SHALL be kept for the M3 log assertion. The script SHALL then wait until `SMOKE` is done and `SMOKE-PARKED` is claimable, and then until `SMOKE-M3-A` and `SMOKE-M3-B` are claimable too, so the claimable set does not change during the drills. No claim the script makes SHALL be a local one: the outage drill's pending write, `--break claimable` and the final claim of `SMOKE-PARKED` all claim with `access: remote`.

#### Scenario: One published, one parked
- **WHEN** the worker step and the waits have passed
- **THEN** `/v1/status` lists `SMOKE` in `byStatus.done` and `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B` in `claimable`, and the `smoke-worker` pod has succeeded

#### Scenario: A rerun on a kept cluster
- **WHEN** the script runs again against a cluster where `SMOKE` is already done
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
