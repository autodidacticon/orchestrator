## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Smoke assertions are named
Every assertion in `deploy/smoke.sh` SHALL print `smoke: pass: <name>` when it holds. The first assertion that does not hold SHALL print `smoke: FAIL: <name>` to stderr, and the script SHALL exit 1. A full pass SHALL end with `smoke: ok`. Under `--dry-run`, an assertion SHALL print its command and run nothing, except the three real-agent assertions, which without `--real-agent` print only `smoke: skip: <name> (needs --real-agent)`, in a dry run or not. No assertion or step SHALL be skipped silently: one that does not run SHALL print `smoke: skip: <name> (<why>)` on stdout. No environment variable SHALL turn an assertion off.

#### Scenario: A false assertion fails the run
- **WHEN** a restart-drill assertion does not hold
- **THEN** the script prints `smoke: FAIL:` with that assertion's name and exits 1 without running later steps

#### Scenario: A dry run says what it skips
- **WHEN** `deploy/smoke.sh --dry-run` runs
- **THEN** every assertion's command is followed by `smoke: skip: <its name> (dry run: nothing is executed)`, except the three real-agent assertions, which print `smoke: skip: <its name> (needs --real-agent)` with no command, and stderr stays empty
