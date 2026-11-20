## MODIFIED Requirements

### Requirement: Daemon image
The repository SHALL carry a multi-stage `Dockerfile` on `node:22-slim` whose build stage compiles `dist/` and whose final stage holds `git`, `openssh-client`, `ca-certificates`, the built `dist/src`, and production dependencies only, runs as the unprivileged `node` user, and puts `orchestrator` (the default command), `orchestrator-ctl`, `orchestrator-worker` (the remote worker loop, specs/worker-pool) and `orchestrator-verifier` (the verifier loop, specs/verifier-pool) on `PATH`.

#### Scenario: Image contents asserted without a Docker daemon
- **WHEN** `test/host/docker.test.ts` runs
- **THEN** it reads the Dockerfile and `.dockerignore` and asserts the base image, the two stages, the installed packages, the production-only install, the four entrypoints, and the ignored paths

#### Scenario: Entrypoints on PATH
- **WHEN** `docker run --rm orchestrator:dev orchestrator-ctl`, `docker run --rm orchestrator:dev orchestrator --help`, `docker run --rm orchestrator:dev orchestrator-worker --help` and `docker run --rm orchestrator:dev orchestrator-verifier --help` are run
- **THEN** each prints its usage

### Requirement: Daemon image: deploy notes
`deploy/README.md` SHALL name the image, the build command, and the four entrypoints.

#### Scenario: The notes name the image and how to build it
- **WHEN** `test/host/docker.test.ts` reads `deploy/README.md`
- **THEN** it contains `orchestrator:dev`, the command `docker build -t orchestrator:dev .`, and the entrypoint names `orchestrator`, `orchestrator-ctl`, `orchestrator-worker` and `orchestrator-verifier`, each in backticks

### Requirement: Reference manifests
`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a CloudNativePG `Cluster` `postgres`; a ClusterIP Service `orchestrator` on port 8080; the worker Deployment `orchestrator-worker` (see "Worker Deployment"); and the verifier Deployment `orchestrator-verifier` (see "Verifier Deployment").

#### Scenario: Base renders every resource
- **WHEN** `kubectl kustomize deploy/base` runs
- **THEN** the output holds the Namespace, the ConfigMap, the Postgres Cluster, the worker Deployment at `replicas: 0`, the verifier Deployment at `replicas: 0`, the Recreate Deployment on an `emptyDir` reading the store URL from the Secret mounted as a file and holding no store URL, password or libpq variable in its environment, and the Service, and no PersistentVolumeClaim

#### Scenario: Kind overlay supplies the origin and a ready task
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** the output adds `git-origin` and points `REPO_URL` at it; its `orchestrator.yaml` is the base file plus `runner.access: remote`, `git.workerOriginUrl: git://git-origin.orch.svc:9418/fixture.git`, `verifier.mode: remote` and `capacity: 3`; the worker Deployment carries `ORCH_WORKER_AGENT=scripted` and `replicas: 0`; the verifier Deployment runs at `replicas: 1`; the overlay's `graph.yaml` is not mounted, and it holds one ready task that the daemon parks as claimable once the smoke script sends it with `PUT /v1/graph`

### Requirement: Reference manifests: kind overlay remote run
`deploy/overlays/kind` SHALL make the run remote: its own `orchestrator.yaml` replaces the base file in `orchestrator-config` (`behavior: replace`), holding every base key plus `runner.access: remote`, `git.workerOriginUrl` set to the `git-origin` Service URL, `verifier.mode: remote` and `capacity: 3` (so every dependant of `SMOKE` is parked before the drills), and a patch sets `ORCH_WORKER_AGENT=scripted` on `orchestrator-worker`.

#### Scenario: The overlay's file is the base file plus the remote keys
- **WHEN** `test/host/deploy.test.ts` compares the `orchestrator.yaml` of `deploy/overlays/kind` with that of `deploy/base`
- **THEN** the overlay's file has `runner.access: remote`, `git.workerOriginUrl` equal to the init container's `REPO_URL`, `verifier.mode: remote` and `capacity: 3`, the base file has no `runner.access` and no `verifier`, and with those four keys taken out the two files are equal

### Requirement: Smoke test
`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin`, `orchestrator` and `orchestrator-verifier`. M2 asserts that the daemon pod has no volume backed by a claim, then runs the restart, outage and Postgres-restart drills.

#### Scenario: Dry run prints the steps in order
- **WHEN** `deploy/smoke.sh --dry-run` runs with every tool stubbed out
- **THEN** it prints the build, load, operator install, apply, waits (the verifier's rollout after the daemon's), port-forward, graph upload, M1 poll, claim check, pod deletion and M2 poll in that order, executes nothing, and exits 0

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

### Requirement: Smoke test: M3 and M4 steps
M3 SHALL scale the worker Deployment and SHALL assert that the workers finish the run (see "Smoke M3 step"). M4 SHALL check the Claude worker image, a worker pod deleted mid-task and the launch trailers (see "Smoke M4 step"). M5 SHALL then check that a verifier pod runs each check (see "Smoke M5 step"), and with `--real-agent` the script SHALL run the real-agent step last (see "Smoke real-agent step").

#### Scenario: Dry run order of the M3 and M4 steps
- **WHEN** `deploy/smoke.sh --dry-run` runs without `--real-agent`
- **THEN** the M4 block A assertions come after the final claim of `SMOKE-PARKED` and before the scale of `orchestrator-worker` to 2, the three M3 assertions follow that scale, the M4 block B assertion comes after them, the eight M5 assertions follow it, and the three real-agent skip lines come last

### Requirement: Smoke real-agent step
With `--real-agent <key file>`, `deploy/smoke.sh` SHALL run the real-agent step as its last step: Claude workers holding the key work the added task `SMOKE-REAL`, and it asserts `M4: the real task is done` (within `REAL_TIMEOUT_S`, default 900), `M4: the real task's launch cost is above zero` and `M4: the real task's commit carries its Orchestrator-Launch trailer`. Without the option each of the three SHALL print `smoke: skip: <name> (needs --real-agent)`, in a dry run too.

#### Scenario: The key file rule
- **WHEN** `--real-agent` has no value, or names a path that is not a readable regular file, a symbolic link, or a file whose directory's physical path is the repository root or below it
- **THEN** the script prints one line on stderr and exits 2 before any step and before any tool is called; a relative path is read against the caller's working directory

#### Scenario: The steps
- **WHEN** `deploy/smoke.sh --dry-run --real-agent <file>` runs
- **THEN** after the M5 assertions it lists the Secret step, the scale of `orchestrator-worker` to 0 and the wait for no worker pod, `apply -k deploy/overlays/kind-claude`, the upload of `graph.yaml`, `graph-m5.yaml` and `real-task.yaml` in that order (`put_graph_with deploy/overlays/kind/graph-m5.yaml deploy/overlays/kind-claude/real-task.yaml`), the wait for `SMOKE-REAL` to be claimable, the scale to 1 and the three assertions, calls no tool, and does not read the file

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

### Requirement: Deploy notes state who the layout is for

`deploy/README.md` SHALL state, in a section before the image section, that the reference manifests are a single-user preview on kind, which routes read the launch token and which the verify job token, that the verify claim reads no credential, who reaches the API in the reference manifests, and that the Service is not to be exposed. It SHALL name the hardening milestone as the place authentication comes from.

#### Scenario: A reader looks for the API's exposure

- **WHEN** a reader opens `deploy/README.md`
- **THEN** a section before "Daemon image" says the layout is a single-user preview on kind; that the six routes a worker calls read the launch token and the verify job routes under `/v1/verify/` (`heartbeat`, `result` and `release`) read the job token; that `POST /v1/verify/claims` reads no credential, so until the hardening milestone any pod that reaches the API, a worker's agent included, can claim a verify job and post its result; that under `verifier.mode: local` the check command runs as the daemon's user beside the store URL file, and under `remote` in a verifier pod that mounts no Secret; that every pod in the cluster and every user who may port-forward into namespace `orch` reaches the API; that the Service must not be exposed through an Ingress, a NodePort or a LoadBalancer; and that authentication comes with the hardening milestone

## ADDED Requirements

### Requirement: Verifier Deployment
`deploy/base/verifier.yaml` SHALL be a Deployment `orchestrator-verifier` with `replicas: 0`, the label `app.kubernetes.io/name: orchestrator-verifier` on its selector and pod template, uid, gid and `fsGroup` 1000, and one container `verifier` on `orchestrator:dev` whose command is `["orchestrator-verifier"]`. The pod SHALL mount no volume claim and no Secret volume. `deploy/base/kustomization.yaml` lists it after `worker.yaml`.

#### Scenario: Base renders the verifier Deployment
- **WHEN** `test/host/deploy.test.ts` renders `deploy/base` and `deploy/overlays/kind`
- **THEN** each holds `Deployment/orchestrator-verifier` with the label on selector and template, uid, gid and `fsGroup` 1000, and one container `verifier` on `orchestrator:dev` with command `["orchestrator-verifier"]`; the base at `replicas: 0`; no volume is a Secret, a `persistentVolumeClaim` or an `ephemeral` volume

#### Scenario: The daemon's selectors never match a verifier pod
- **WHEN** the Service `orchestrator` or `deploy/smoke.sh` selects pods by `app.kubernetes.io/name=orchestrator`
- **THEN** no verifier pod matches, because its label is `orchestrator-verifier`

### Requirement: Verifier Deployment: environment
The container `verifier` SHALL set `POD_NAME` from the Downward API's `metadata.name`, `ORCH_API` to the daemon Service URL `http://orchestrator.orch.svc:8080`, and `ORCH_VERIFIER_CACHE=/var/cache/orchestrator`, mounted from an `emptyDir`. Its environment SHALL hold no `envFrom`, no variable read from a Secret, no `DATABASE_URL` or `DATABASE_URL_FILE`, no name starting with `PG`, and in the base no `ORCH_VERIFIER_BACKOFF_MAX_MS`.

#### Scenario: Environment of the rendered container
- **WHEN** `test/host/deploy.test.ts` reads the container `verifier` of either render
- **THEN** `POD_NAME` comes from `metadata.name`, `ORCH_API` equals the URL built from the Service's name, namespace and port, an `emptyDir` is mounted at `ORCH_VERIFIER_CACHE` (`/var/cache/orchestrator`), and there is no `envFrom`, no `secretKeyRef`, no database variable and no `PG*` name

#### Scenario: No token in M5
- **WHEN** a verifier pod claims a verify job
- **THEN** it sends `POST /v1/verify/claims` with no credential; the verifier token comes with the M6 cluster tokens

### Requirement: Verifier Deployment: kind overlay
`deploy/overlays/kind` SHALL patch `orchestrator-verifier` to `replicas: 1` and add `ORCH_VERIFIER_BACKOFF_MAX_MS=2000`, and its `orchestrator.yaml` SHALL set `verifier.mode: remote`. The base `orchestrator.yaml` keeps `local`, the default.

#### Scenario: One verifier with a short backoff
- **WHEN** `kubectl kustomize deploy/overlays/kind` runs
- **THEN** `orchestrator-verifier` has `replicas: 1` and `ORCH_VERIFIER_BACKOFF_MAX_MS` `2000`, and the overlay's `orchestrator.yaml` has `verifier.mode: remote`

#### Scenario: One replica is enough
- **WHEN** the daemon offers verify jobs under `verifier.mode: remote`
- **THEN** it offers one job at a time, so a second verifier replica would only idle

### Requirement: Verifier Deployment: deploy notes
`deploy/README.md` SHALL have a section "The verifiers", before "Claude worker image", that describes the Deployment and its variables, `verifier.mode: remote` and its start rule, one job offered at a time and so one replica, that a verifier idles against a daemon under `local`, that the pods mount no Secret and hold no database variable, and what a verifier pod does on SIGTERM.

#### Scenario: A reader looks for where checks run
- **WHEN** a reader opens `deploy/README.md`
- **THEN** "Daemon image" names four entrypoints and says one image serves the daemon, the workers and the verifiers, and that a project whose check needs a toolchain builds an image from `orchestrator:dev` for the verifier Deployment; "The workers" says a checked submission is checked in the daemon's container under `local` and by a verifier pod under `remote`; "The verifiers" says that on SIGTERM the loop kills the check, releases its job and exits 0

#### Scenario: Store credentials and shutdown
- **WHEN** a reader opens "Store credentials" in `deploy/README.md`
- **THEN** it says a check runs in the daemon's container under `verifier.mode: local` and in a verifier pod under `remote`, that worker and verifier pods mount no store Secret, and that under `remote` a SIGTERM'd daemon does not wait for a job that waits for a verifier, while the next start keeps that job when a verifier holds it or has posted its result and queues it again otherwise

### Requirement: Smoke M5 step
After the M4 block B assertion and before the real-agent step, `deploy/smoke.sh` SHALL start the process probe, send `graph.yaml` and `graph-m5.yaml` with `PUT /v1/graph`, restart `orchestrator-worker` and wait for its rollout, then assert `M5: orchestrator, orchestrator-worker and orchestrator-verifier are deployed`, `M5: SMOKE-M5-PASS is published` and `M5: SMOKE-M5-BREAK is blocked after its attempts`, then stop the probe before the other five.

#### Scenario: A verifier pod checks the M5 tasks
- **WHEN** `deploy/smoke.sh --fresh` runs against the kind cluster
- **THEN** it prints `smoke: pass:` for the eight M5 assertions: the three Deployments exist with the verifier at one ready replica; within `FINISH_TIMEOUT_S` `SMOKE-M5-PASS` is done with its `Orchestrator-Task` trailer on origin's `main`; within `FINISH_TIMEOUT_S` `SMOKE-M5-BREAK` is blocked, its overlay row (`pg_m5_reason`) holds `attempts exhausted after 2: checkFailed`, and origin's `main` has no trailer for it; and the script ends with `smoke: ok`

#### Scenario: Dry run lists the M5 assertions
- **WHEN** `deploy/smoke.sh --dry-run` runs
- **THEN** it lists every assertion name it listed before, then the eight M5 names, each after its command and with its `(dry run: nothing is executed)` skip line, after the block B line and before the three real-agent skip lines; the steps `start_probe`, `put_graph_with deploy/overlays/kind/graph-m5.yaml`, `rollout restart deployment/orchestrator-worker`, `rollout status deployment/orchestrator-worker` and `stop_probe` come in that order

#### Scenario: Workers restarted after the upload
- **WHEN** the M5 graph arrives while the workers sit in a restart delay after the finished run
- **THEN** the rollout restart made after the upload gives fresh worker pods that see an unfinished run

### Requirement: Smoke M5 step: fixture check and fragment
The kind fixture's check `fixture/test.js` SHALL wait 5 seconds and then fail when `README.md` is missing or has a line that starts with `- SMOKE-M5-BREAK `, and pass otherwise. `deploy/overlays/kind/graph-m5.yaml` SHALL be a graph fragment, not mounted, whose two nodes `SMOKE-M5-PASS` and `SMOKE-M5-BREAK` follow `graph.yaml`'s nodes.

#### Scenario: The fixture check by hand
- **WHEN** `node deploy/overlays/kind/fixture/test.js` runs in a directory with a `README.md`, with one that holds `- SMOKE-M5-BREAK by worker w`, and with none
- **THEN** the first exits 0 after at least 5 seconds and prints `fixture check: ok`; the second exits 1 and prints `fixture check: README.md names a task that breaks the check`; the third exits 1

#### Scenario: The fragment parses after graph.yaml
- **WHEN** `test/host/deploy.test.ts` parses `graph.yaml` followed by `graph-m5.yaml` with `parseGraph`
- **THEN** exactly `SMOKE-M5-PASS` and `SMOKE-M5-BREAK` are added and every node of `graph.yaml` is unchanged; each new node is a task with `deps: [SMOKE]`, a description, one acceptance criterion and no `model`, which `SlotValidator` accepts; `graph-m5.yaml` has no `nodes:` line; and `graph.yaml`, `graph-m5.yaml` and `real-task.yaml` parse as one graph that also adds `SMOKE-REAL`

### Requirement: Smoke M5 step: process probe
`deploy/smoke.sh` SHALL sample the processes under the daemon container's pid 1 and under each running verifier pod's pid 1 from the start of the M5 step until its third assertion has passed, and SHALL assert `M5: the check ran in a verifier pod and never under the daemon` from those samples.

#### Scenario: What one sample reads
- **WHEN** the probe takes a sample of a container
- **THEN** it runs one `kubectl exec` with only `sh`, `cat`, `sed`, `grep`, `tr` and `sleep`, which prints pid 1's command line and reads, twice and one second apart, the processes whose `PPid:` is 1 and whose `State:` is not `Z`, and reports each pid found in both reads whose `comm` is not `git`; it never looks for the text `sh -c`

#### Scenario: Samples that do not count
- **WHEN** a sample's `kubectl exec` fails, or the second field of its pid 1 command line is not exactly `/usr/local/bin/orchestrator` (daemon) or `/usr/local/bin/orchestrator-verifier` (verifier)
- **THEN** the sample is printed and not counted, and the assertion does not fail on it

#### Scenario: The assertion
- **WHEN** the probe has stopped
- **THEN** the assertion holds when no daemon sample reported a child, at least one verifier sample did, and at least five daemon samples were taken; it prints the three counts and the slowest round, and `cleanup` stops the probe and removes its files when the script exits early

### Requirement: Smoke M5 step: failed jobs and verifier logs
`deploy/smoke.sh` SHALL assert `M5: the failed jobs are checkFailed with the check's output` from the rows that `pg_m5_jobs` reads in `orchestrator.verifier_jobs`, and `M5: verifier logs show the check` from the verifier pods' logs read with `--tail=-1`, whose lines `verifier <id> <event> <jobId> <taskId>` and check output show each check of the two M5 tasks.

#### Scenario: Two failed job rows
- **WHEN** `SMOKE-M5-BREAK` is blocked
- **THEN** `pg_m5_jobs`, filtered on this run's `run_id`, reads exactly two rows for it, each `failed` with `doc->>'failureKind'` `checkFailed` and a `doc->>'output'` that holds `fixture check: README.md names a task that breaks the check`

#### Scenario: The logs show each check
- **WHEN** the log assertion reads the verifier pods' logs, printing each verifier container's restart count
- **THEN** they hold a `check` and a `verified` line for `SMOKE-M5-PASS` with `fixture check: ok` in that check's output, and two `check` and two `checkFailed` lines for `SMOKE-M5-BREAK` naming the two job ids `pg_m5_jobs` read, each check's output holding `fixture check: README.md names a task that breaks the check`

### Requirement: Smoke M5 step: daemon side and the finished run
`deploy/smoke.sh` SHALL assert `M5: the daemon pod made no verification worktree` (no `<runDir>/verify` in the daemon container) and then `M5: the run is finished again`: it cancels `SMOKE-M5-BREAK` and `/v1/status` says `finished: true` within `STATUS_TIMEOUT_S`.

#### Scenario: A rerun after a full pass
- **WHEN** `deploy/smoke.sh` runs again on the cluster after a full pass
- **THEN** the finished-run check refuses it, with its line naming `--fresh`, and not a graph upload that drops `SMOKE-M5-PASS`

#### Scenario: A pass that failed in or after the M5 step
- **WHEN** a pass failed in or after the M5 step once `SMOKE-M5-PASS` or `SMOKE-M5-BREAK` had started, and the next pass runs on that cluster without `--fresh`
- **THEN** it is refused: at step 7's upload of `graph.yaml` alone (`removedStarted`) while the run is unfinished, or by the finished-run check once it is finished; that pass is run with `--fresh`. This is the exception to "Smoke worker step" scenario "A rerun on a kept cluster"

#### Scenario: A cluster kept from before this change
- **WHEN** the M5 step runs on a cluster whose git-origin was seeded before the breaking fixture check came
- **THEN** `SMOKE-M5-BREAK` would pass its check, so the M5 step needs a cluster made with `--fresh` after this change
