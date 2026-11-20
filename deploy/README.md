# deploy

Everything for running the orchestrator in a cluster lives here. The specification is `openspec/specs/cluster-runtime/spec.md`, with the process-level behaviour (signalled shutdown, JSON logs, the remote `ORCH_URL`) under the "Container mode" requirement of `openspec/specs/operator-control/spec.md`.

## Who this layout is for

`deploy/base` and the kind overlay are a preview for one user on a kind cluster. They are not a layout for a shared cluster.

The API reads two credentials. The launch token is read by the six routes a worker calls: `heartbeat`, `report`, `block`, `log`, `inbox` and `renew`. The verify job token, which a verify claim answers, is read by the three verify job routes under `/v1/verify/`: `heartbeat`, `result` and `release`. `POST /v1/verify/claims` reads no credential, so until the hardening milestone any pod that reaches the API, a worker's agent included, can claim a verify job and post its result. Every other route, the operator routes and the two probes included, answers any caller. A caller of port 8080 can therefore set `runnerCommand` and `checkCommand`. Under `verifier.mode: local` (the base) the check command runs as the daemon's user, beside the store URL file and the clone that pushes to origin; under `remote` (the kind overlay) it runs in a verifier pod, which mounts no Secret.

The Service is a ClusterIP with no NetworkPolicy, so every pod in the cluster reaches the API. So does every user who may run `kubectl port-forward` into namespace `orch`. Do not expose the Service through an Ingress, a NodePort or a LoadBalancer. The kind overlay's git origin accepts pushes from any pod without authentication.

The daemon answers 403 to any request that carries an `Origin` header, on every bind. It checks the `Host` header only on a loopback bind; this manifest binds `0.0.0.0`, so the probes and a port-forward are not affected. This keeps a browser page from calling the API and is not authentication.

Authentication comes with the hardening milestone (#34).

## Daemon image

The image is `orchestrator:dev` when built locally, from the `Dockerfile` at the repository root:

```sh
docker build -t orchestrator:dev .
```

It is multi-stage on `node:22-slim`: the build stage compiles `dist/`, and the final stage holds Node, `git`, `openssh-client`, the built `dist/src`, and production dependencies only. It carries no project toolchain. One image serves the daemon, the workers and the verifiers. A project whose agent needs a toolchain builds a worker image from `orchestrator:dev` (see "Claude worker image"); a project whose check needs a toolchain builds an image from `orchestrator:dev` that installs it and sets it on the verifier Deployment (see "The verifiers").

Four entrypoints are on `PATH`:

- `orchestrator`: the daemon (the default command).
- `orchestrator-ctl`: the operator CLI.
- `orchestrator-worker`: the remote worker loop, which the worker Deployment runs (see "The workers").
- `orchestrator-verifier`: the verifier loop, which the verifier Deployment runs (see "The verifiers").

```sh
docker run --rm orchestrator:dev orchestrator --help
docker run --rm orchestrator:dev orchestrator-ctl
docker run --rm orchestrator:dev orchestrator-verifier --help
```

The image runs as the unprivileged `node` user.

## Probes

The daemon answers two probes on its API port. Like the operator routes they take no credential (see "Who this layout is for"). Neither one counts as activity for the idle exit.

- `GET /healthz`: 200 `{ ok: true }` whenever the process is serving. Use it for liveness.
- `GET /readyz`: 200 `{ ok: true }` when the store answers a query, the repository path is readable, and the integration branch resolves to a commit. Under a Postgres store it is also not ready while the store's flush lag has been above zero for longer than one flush retry, and once the session holding the run lock is lost. Otherwise it answers 503 `{ ok: false, reasons: [...] }`, with one entry per failed check. Use it for readiness.

## Manifests

Kustomize, rendered with `kubectl kustomize` (no cluster is contacted):

```sh
kubectl kustomize deploy/base
kubectl kustomize deploy/overlays/kind
kubectl kustomize deploy/overlays/kind-claude
```

```
deploy/
  base/                 the daemon and the worker and verifier pools, in namespace orch
    kustomization.yaml
    namespace.yaml      Namespace orch
    orchestrator.yaml   ConfigMap orchestrator-config (hash-suffixed, so a change rolls the daemon)
    postgres.yaml       CloudNativePG Cluster postgres (the run's state)
    deployment.yaml     Deployment orchestrator (Recreate, emptyDir, no volume claim)
    service.yaml        Service orchestrator, ClusterIP, port 8080
    worker.yaml         Deployment orchestrator-worker (replicas 0, emptyDir clone cache)
    verifier.yaml       Deployment orchestrator-verifier (replicas 0, emptyDir clone cache; see "The verifiers")
  worker-claude/
    Dockerfile          the Claude worker image, orchestrator-worker-claude:dev (see "Claude worker image")
  overlays/kind/        base plus an in-cluster git origin, a remote run with remote verification, scripted workers
                        and one verifier
    kustomization.yaml  sets REPO_URL to the origin, replaces orchestrator.yaml, sets ORCH_WORKER_AGENT=scripted,
                        patches orchestrator-verifier to replicas 1 with ORCH_VERIFIER_BACKOFF_MAX_MS=2000
    orchestrator.yaml   the base file plus runner.access: remote, git.workerOriginUrl, verifier.mode: remote and
                        capacity: 3
    git-origin.yaml     PVC, Deployment and Service git-origin
    graph.yaml          the graph deploy/smoke.sh sends with PUT /v1/graph
    graph-m5.yaml       graph fragment: SMOKE-M5-PASS and SMOKE-M5-BREAK, sent by the smoke's M5 step after graph.yaml
    fixture/            the files seeded into the origin's repository (test.js is the check)
  overlays/kind-claude/ the kind overlay with Claude workers (see "The kind overlay")
    kustomization.yaml  the kind overlay plus orchestrator-worker on orchestrator-worker-claude:dev with the key's Secret
    real-task.yaml      graph fragment: the node SMOKE-REAL, sent by deploy/smoke.sh --real-agent after graph.yaml
                        and graph-m5.yaml
```

### The daemon

The `orchestrator` Deployment runs one daemon with strategy `Recreate`. It has no volume claim: `/data` is an `emptyDir`, so every pod starts empty.

- `/data/repo`: the clone the daemon integrates into, made fresh by the init container on every start.
- `/data/home`: `ORCH_HOME`, the run directory (worktrees, logs, `daemon.json`). Nothing in it has to survive a restart.

The run's state (tasks, launches, events, outbox, the accepted and proposed graphs) is in Postgres: `store.kind: postgres`, with the connection URL read from the CloudNativePG application Secret `postgres-app` (key `uri`), which is mounted as the file `/var/run/secrets/orchestrator/postgres/uri` and named by `store.urlFile` (see "Store credentials" below). The integration branch and the milestone tags are on origin (`git.pushIntegration: true`). A new pod therefore takes the run lock, loads the run from Postgres, fetches origin, and continues: a parked launch's worktree is prepared again, a claimed launch whose worktree is gone is ended and retried, and a queued verifier job whose sealed commit the new clone lacks fails its task without spending an attempt. Two daemons never write one run: the second one cannot take the run's Postgres lock and exits, and the pod restarts until the first is gone.

### The workers

The `orchestrator-worker` Deployment (`deploy/base/worker.yaml`) is the remote worker pool. Each pod runs `orchestrator-worker` (specs/worker-pool), which claims a launch with `access: remote` over the daemon's API, clones the repository into its clone cache, checks out the launch branch, runs the agent, and claims again. The agent commits on the branch and submits; the daemon seals the submission by fetching that branch from origin and comparing its tip with the report's `sealedSha`. The daemon then publishes the checked submission: under `verifier.mode: local` (the base) it checks it in its own container, and under `remote` (the kind overlay) a verifier pod checks it (see "The verifiers"). An agent that reports through the shim's `report` tool (the `orchestrator` MCP server the loop names in `.orchestrator/mcp.json`) needs to push nothing: the loop writes `ORCH_ACCESS=remote`, `ORCH_WORKTREE` (the clone) and `ORCH_BRANCH` (the launch branch) into the shim's `env`, and on a submit the tool checks that the clone is clean (409 `dirtyWorktree`), force-pushes `HEAD` to the launch branch on origin within 60 seconds (503 `pushFailed`), and names the pushed commit as `sealedSha`. An agent that calls the API itself pushes the branch and sends `sealedSha` itself, and the loop's fallback relay pushes and names it for a report left in `.orchestrator/report.json`. A worker exits 0 when `/v1/status` says the run is finished, and the Deployment then restarts it.

- `POD_NAME`, from the pod's `metadata.name` through the Downward API, is the worker id the daemon records for each claim.
- `ORCH_API` is the daemon Service, `http://orchestrator.orch.svc:8080`.
- The clone cache, `ORCH_WORKER_CACHE=/var/cache/orchestrator`, is an `emptyDir`: one clone per repository for the pod's life, and a new pod clones again. Like the daemon, a worker has no volume claim.
- The pods carry the label `app.kubernetes.io/name: orchestrator-worker`, so the daemon's Service and the selectors on `orchestrator` never match them.

The base sets `replicas: 0` and no agent. A deployment sets the replicas and either `ORCH_WORKER_AGENT=scripted` or the agent command template in `ORCH_WORKER_COMMAND` (the default agent, `command`, refuses to start without one). `ORCH_WORKER_TASK` makes a worker claim only that task id, and `ORCH_WORKER_MAX_LAUNCHES` makes it exit 0 after that many launches; the smoke test uses both for its one-task worker pod. `ORCH_WORKER_RUNNER` names the runner kind the worker's agent runs (`claude-code`, `codex` or `opencode`), or a comma-separated list of kinds, and the loop claims only launches of those kinds; a value outside the kinds refuses the start with exit 2. Unset, the loop claims launches of every runner kind, and a loop with the `command` agent says so in one stderr line at its start.

When a heartbeat of the loop is answered 401, the daemon has ended the launch: it was cancelled, failed as stuck (the daemon applies `health.stuckFailAfterMs` to a claimed launch, and the loop keeps no silence clock of its own), or ended after its task reported. The loop then reads the status once. When the task is submitted or done, the command agent keeps 30 seconds to exit by itself, so the usage object it prints is posted; in any other state, or when the status cannot be read, it is stopped at once. Stopping is the same SIGTERM, then SIGKILL after `ORCH_WORKER_AGENT_STOP_MS`, as on termination, and the loop prints `agent-ended`. It releases nothing for that launch and claims again.

When a worker pod is deleted (eviction, a rollout, a scale-down), the kubelet sends SIGTERM to `orchestrator-worker`, the container's command, and the loop hands its launch back instead of letting the lease expire and spend an attempt (specs/worker-pool "Pod termination"). SIGINT does the same; a second signal changes nothing, and the loop claims no more. The loop stops the agent: SIGTERM to the agent's process group, and SIGKILL to the group after `ORCH_WORKER_AGENT_STOP_MS` (default 10000; 0 kills at once). It then relays a fallback report the agent left and reads the status: a report that was accepted, or a launch that has ended, is left alone. A launch it still holds is committed as one work-in-progress commit (`git add -A` outside `.orchestrator/`, hooks skipped), pushed to the launch branch on origin (forced, 30 seconds at most), and released with keep and reason `podTerminating`, so the next launch of the task starts at the pushed head. The worker Deployment sets `terminationGracePeriodSeconds: 120`, which covers every wait at its limit (100 seconds, with the usage post). No preStop hook is used: the container's command is the loop itself, so a hook would only delay the signal.

When the push fails, the loop does not release; when the release is refused or gets no answer, it does not try again. Either way it prints `push-failed` or `release-failed`, exits 1, and the lease expiry decides from what origin holds: a branch tip other than the base is kept (reason `leaseExpired`), and nothing pushed fails the attempt. An idle worker exits 0 at once; a launch whose agent had not started is released without keep.

The loop also posts what a launch cost (specs/worker-pool "Usage post"). It keeps the last 256 KiB of the command agent's standard output (which still goes to the loop's stderr), and once the agent has exited it reads the result object a Claude Code agent (`claude -p --output-format json`) prints at the end. When that object has token counts, the loop posts them, the claim's model and the object's `total_cost_usd` (when above zero) to `POST /v1/launches/:id/usage` as the last step of the launch: after `report accepted`, a release or an ended launch, and on termination after a release that was answered (its call retries for at most 5 seconds, inside the grace period). A recorded post prints `worker <id> usage <launchId> <taskId>`; any other answer goes to stderr and changes nothing else. These launches record no usage: those of the scripted agent, of an agent that printed no such object (or printed a line after it) or an object without token counts, of an `ORCH_WORKER_COMMAND` that runs another CLI, and terminated launches whose push failed or whose release got no answer. The daemon prices posted tokens that come without a cost from `budgets.prices`, and `budgets.maxRunCostUsd` counts the posted cost like that of any launch, so the run cost budget applies to the cluster's launches.

Workers claim only from a remote run. The daemon's `orchestrator.yaml` must set `runner.access: remote`, which needs pull mode, `git.pushIntegration: true`, `apiBaseUrl`, no `prepareCommand`, and a runner kind whose commit policy is `agent` (the daemon refuses to start otherwise). A remote run answers a claim without `access: remote` with 409. A remote claim answers `repoUrl`, the URL the worker clones: `git.workerOriginUrl` when it is set, else `git.originUrl`, else the daemon clone's `origin`. Set `git.workerOriginUrl` when workers reach origin at another URL than the daemon does.

#### The run id

Many runs can share one database: their rows are in the tables of one schema, `orchestrator` by default, named by `store.schema`, keyed by `run_id`, and each daemon holds an advisory lock keyed by it; the advisory locks are per database, not per schema. Every deployment from this manifest clones into the same path, `/data/repo`, so the run id does not come from the path. With `store.kind: postgres` the daemon picks it in this order:

1. `store.runId` in `orchestrator.yaml` (the ConfigMap);
2. the environment variable `ORCH_RUN_ID`;
3. a hash of `git.originUrl`, when set;
4. with `git.pushIntegration: true`, a hash of the clone's `origin` remote, which is `REPO_URL`. This is what the base manifest uses: each deployment cloning a different repository gets its own run id, with nothing to set. User information in the URL (a token) is left out of the hash, so rotating a credential keeps the id;
5. otherwise the repository path hash, with one warning in the log. Every deployment on the same path and database would share that run.

Daemons that share a database are upgraded together: a daemon refuses to open a database whose `orchestrator_migrations` table records a migration version it does not know, which a newer release has written. The check runs at startup only. A run that loads empty logs one warning, and records a `config.warning` event, when another schema of the same database holds orchestrator tables; the warning names those schemas and says to set `store.schema` if the run's state is there.

An origin hash follows the URL as written, with two exceptions. User information is left out of every address the daemon can parse as a URL. For `http://` and `https://` URLs the host is lowercased and the scheme's default port (80 or 443) is dropped. An `ssh://` or `git://` URL keeps its host as written and keeps a port even when it is the default, so `ssh://git@GIT.example.com/team/project.git`, `ssh://git@git.example.com:22/team/project.git` and `ssh://git@git.example.com/team/project.git` are three run ids. An scp-like address with a user (`git@git.example.com:team/project.git`) and a local path are taken unchanged, capitals included. An scp-like address without a user (`git.example.com:team/project.git`) is read as a URL whose scheme is the host name, so only its host is lowercased. No form loses a `.git` suffix or a trailing slash, so these spellings of one repository are three run ids, and so three runs in one database:

```
https://git.example.com/team/project.git
https://git.example.com/team/project
https://git.example.com/team/project/
```

The rule is fixed: a later release does not change the run id of a spelling. `test/runs/run-id-vectors.test.ts` holds the id of each spelling above as a literal.

So are `git@git.example.com:team/project.git` (an scp-like address, taken as written, user included) and `ssh://git@git.example.com/team/project.git` (a URL, whose user `git` is left out). The same spelling with another token (`https://x-access-token:...@git.example.com/team/project.git`), or none, keeps the id. `https://GIT.example.com:443/team/project.git` gives the same id as the first line above. Keep `REPO_URL` (or `git.originUrl`) spelled the same across redeployments. To make the id independent of the spelling, pin it with `store.runId` or `ORCH_RUN_ID`; a deployment that already has state keeps it by pinning the id it has now, which `/v1/status` shows as the last part of `runDir`.

Set `store.runId` or `ORCH_RUN_ID` when two deployments clone the same repository into one database (for example a staging and a production run of one project), or when the id must survive a change of `REPO_URL`. An explicit id is 1 to 64 characters of `A-Z a-z 0-9 _ -`; any other value stops the daemon at startup with a message naming it. The run directory under `ORCH_HOME` is named after the id, and `deploy/smoke.sh` reads it from `/v1/status` (`runDir`).

#### Store credentials

**Where the daemon reads the URL.** With `store.kind: postgres` and no `store.url` in the config file, the daemon reads the URL from the first of these that is set:

1. the file named by `store.urlFile`;
2. the file named by `DATABASE_URL_FILE`;
3. `DATABASE_URL`.

A URL file holds the URL and nothing else; surrounding whitespace is trimmed. The daemon reads it once, at startup. A file that cannot be read, or is empty, stops the daemon with a message naming the file but never the URL. Two sources at once are refused: `store.url` with `store.urlFile`, or `DATABASE_URL` with `DATABASE_URL_FILE` when `store.urlFile` is unset. A `store.urlFile` in a tracked config file is allowed, since it is a path. A `store.url` in a tracked config file is refused at startup, because every worktree would carry it. The mounted `orchestrator.yaml` is excluded from the clone.

**What the daemon removes from its children's environments.** `ORCH_RUN_ID` is removed on every store kind. The database variables below are removed when the store the daemon opened is Postgres, and under SQLite only when the config file leaves `store.kind` unwritten while a Postgres input (a key of its `store` block, or `ORCH_RUN_ID`) is set. This manifest's store is Postgres, so the list applies here. Check commands, agents (of every runner kind, and what they start) and the daemon's own git commands, with any project git hook those run (such as `pre-commit` on a kept-release WIP commit, or one run by the verifier's rebase), run without these variables:

- `DATABASE_URL`, `DATABASE_URL_FILE` and `ORCH_RUN_ID`;
- every libpq connection variable in `LIBPQ_VARS` (`src/runs/childEnv.ts`), such as `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR`, `PGSSLMODE`, `PGSSLKEY` and `PGSSLROOTCERT`;
- any variable whose value is the store URL.

The libpq names are removed whatever their values, so a URL built from parts (`postgres://host/db` plus `PGPASSWORD`) does not get through either. A check command that needs `PG*` variables of its own, for a test database say, must set them itself.

**What the daemon cannot remove.** Under `verifier.mode: local` (the base) a check command runs as the daemon's user, in the daemon's container; under `remote` (the kind overlay) it runs in a verifier pod instead (see "The verifiers"). An agent the daemon spawns (`runner.mode: spawn` or `mixed`) runs in the daemon's container too, and so does a pull-mode worker that works a local launch's worktree there. With this manifest the workers are pods of their own: a remote launch is worked in the worker pod's clone, and worker and verifier pods mount no store Secret and hold no database variable. A process in the daemon's container can still read:

- the URL file. The Secret mount is mode 0440, readable through the pod's `fsGroup`, which is the daemon's group;
- the daemon's environment as the daemon was started (`/proc/<daemon pid>/environ`). This holds the URL or the password if the deployment passes `DATABASE_URL` or a `PG*` variable to the daemon;
- the daemon's memory, where the kernel lets a process of the same user read it. One example is `/proc/<daemon pid>/mem` when Yama `ptrace_scope` is 0.

The daemon does not prevent these reads, and the spec claims nothing more (specs/state-backend "Store credentials a child can still reach"). A deployment limits them as follows:

- **The daemon's environment.** Give the daemon the URL through a file, not through its environment. This manifest does: the daemon container has no `DATABASE_URL`, no `PG*` variable, no `envFrom` and no variable read from a Secret, so `/proc/<daemon pid>/environ` holds no URL or password.
- **Agents.** In pull mode the daemon spawns no agent (`runner.mode: pull`, as here). A worker reaches what a check command in the daemon's container reaches only when it works inside that container. The worker pods of this manifest do not: they work in their own clones, with no store Secret.
- **The daemon's memory.** Yama `ptrace_scope` at 1 or more on the nodes keeps a child from attaching to its parent, and with that from reading the parent's memory through `/proc/<pid>/mem`. It limits ptrace-style reads only.
- **The URL file.** Nothing in this manifest keeps it from a check command run under `verifier.mode: local`, or from any other process in the daemon's container. Under `remote` the check runs in a verifier pod, which does not mount it. Give the run a database role with no more privileges than the run needs, and let only commands you trust with that role run in the daemon's container.

The init container `clone` clones `REPO_URL` into `/data/repo`. The daemon container then runs `orchestrator --repo /data/repo`, with `/healthz` as its liveness probe and `/readyz` as its readiness probe.

`orchestrator --repo` reads `<repo>/orchestrator.yaml`, so the ConfigMap's `orchestrator.yaml` is mounted into the clone with `subPath` and listed in the clone's `.git/info/exclude`. It takes precedence over a file of the same name in the project. The configuration is:

- `runner.mode: pull`: workers claim launches; the daemon spawns nothing.
- `daemon.idleExitMs: 0`: the daemon never exits on its own.
- `apiBind: 0.0.0.0` and `apiPort: 8080`: the API listens where the Service sends traffic.
- `apiBaseUrl: http://orchestrator.orch.svc:8080`: the URL advertised to agents.
- `store.urlFile: /var/run/secrets/orchestrator/postgres/uri`: the mounted Secret file holding the URL (see "Store credentials"). The run's database role needs USAGE and CREATE on the store's schema at every start, and CREATE on the database only when the daemon is to create the schema itself. The CloudNativePG role `orchestrator` owns the database `orchestrator` (`deploy/base/postgres.yaml`).
- No `store.schema`: the tables are in the default schema, `orchestrator`.
- `store.kind: postgres` and `store.flushDeadlineMs: 120000`: the daemon exits non-zero when a batch cannot reach Postgres within the deadline, or at once when its session (and the run lock) is lost. The worker lease (`leaseTtlMs`, 10 minutes by default) must leave a margin above the deadline: `leaseTtlMs - 2 × floor(leaseTtlMs / 3) >= store.flushDeadlineMs`, or the daemon refuses to start and names both values. A lease of three times the deadline always passes. The default lease of 600000 passes with this manifest's 120000.
- No `health.gapAfterMs` and no `health.gapHoldMs`: the defaults (60000 each) apply. A daemon process that is frozen or starved for longer than `health.gapAfterMs` records a gap, which is left out of the stuck limits and the launch time budget, renews the live launches' leases, and holds admission for `health.gapHoldMs`.
- `git.pushIntegration: true`: origin is the source of truth for the integration branch.

The database URL carries a password. Every surface that prints resolved config (`orchestrator-ctl start`, `orchestrator-ctl config`, `GET /v1/config`, `config.json`, and the log) shows it with the password removed.

The daemon container sets `ORCH_LOG_FORMAT=json`, so every stderr line is one JSON object with `ts`, `level`, `msg`, and the line's data fields. On SIGTERM (a rollout or `kubectl delete pod`) the daemon stops its tick loop, finishes the in-flight tick and, under `verifier.mode: local`, the verifier job it is checking, closes the API server, writes the exit record to `daemon.json`, and exits 0 when every committed batch reached Postgres. When batches are left unflushed it logs their count and exits 1. After 8 seconds it exits anyway, with 1 when batches are still pending and 0 otherwise, and an abandoned check restarts from `queued` on the next start. Under `remote` the daemon does not wait for a job that waits for a verifier: the wait ends at once. The next start keeps that job when a verifier holds it or has posted its result, and queues it again otherwise. `daemon.pid` and `daemon.json` are still written in the run directory, but nothing in the cluster reads them. A client outside the pod reaches the daemon with `ORCH_URL`; when that names a non-loopback host, `orchestrator-ctl` and the operator MCP server never start a local daemon and report the URL as unreachable instead.

The graph is not mounted. Send it with `PUT /v1/graph` (import, or `deploy/smoke.sh`): under a Postgres store the document goes to the store's proposed-graph slot and is reloaded at once. An accepted document becomes the active graph; a rejected one stays in the proposed slot with its reasons, and the active graph is unchanged, across restarts too. Accepting a proposal edits the proposed document the same way.

### The verifiers

The `orchestrator-verifier` Deployment (`deploy/base/verifier.yaml`) is the verifier pool. Each pod runs `orchestrator-verifier` (specs/verifier-pool), the verifier loop: it claims a verify job with `POST /v1/verify/claims`, fetches origin into its clone cache, rebases the sealed commit onto the expected integration head in a worktree of its own, runs the job's check command there, pushes a verified result to `refs/verify/<jobId>`, and posts one of six outcomes (`verified`, `checkFailed`, `checkTimeout`, `conflict`, `rebaseFailed`, `originFailed`) with the job token. The daemon then publishes a verified job, fails the task of a failed one, and deletes the `refs/verify/` ref. The loop prints one line per step, `verifier <id> <event> <jobId> <taskId>`, and after each check writes the command, its exit code and its output to stderr.

- `POD_NAME`, from the pod's `metadata.name`, is the verifier id the daemon records for each claim.
- `ORCH_API` is the daemon Service, `http://orchestrator.orch.svc:8080`.
- The clone cache, `ORCH_VERIFIER_CACHE=/var/cache/orchestrator`, is an `emptyDir`; each job's worktree is under its `verify/` directory.
- `ORCH_VERIFIER_BACKOFF_MAX_MS` bounds the wait between claims when there is nothing to verify (default 30000); the kind overlay sets 2000.
- The pods carry the label `app.kubernetes.io/name: orchestrator-verifier`, uid, gid and `fsGroup` 1000, and run `orchestrator:dev`, as the workers do.

The daemon offers verify jobs only under `verifier.mode: remote` in `orchestrator.yaml`, which needs `runner.access: remote`: a daemon with `remote` and any other access refuses to start. Under `local`, the default and the base's setting, the daemon checks each submission in its own container and offers nothing, so a verifier pod only idles and asks again; the base therefore sets `replicas: 0`. The daemon offers one job at a time, so one replica is enough, and the kind overlay runs one. A project whose check needs a toolchain builds an image `FROM orchestrator:dev` that installs it and sets that image on this Deployment.

The pods mount no Secret and no volume claim, and their environment holds no database variable, no `envFrom` and no variable read from a Secret: a verifier reaches the daemon's API and origin, never the store. The claim reads no credential until the hardening milestone (see "Who this layout is for").

On SIGTERM (a deletion, a rollout or a scale-down) the loop kills the check, releases its job with reason `podTerminating`, and exits 0; the daemon offers the job again. SIGINT does the same. The signal aborts any call in flight, which then has at most 5 seconds left, and no result post starts after it; a result post refused after the signal is also followed by that release (specs/verifier-pool "Verifier termination: refused result post" and "Verifier termination: bounded calls"). The Deployment keeps Kubernetes' default grace of 30 seconds, which covers this, and has no preStop hook: the container's command is the loop itself.

### Claude worker image

`deploy/worker-claude/Dockerfile` builds a worker image whose agent is Claude Code. It is named `orchestrator-worker-claude:dev` when built locally:

```sh
docker build -t orchestrator:dev .
docker build -f deploy/worker-claude/Dockerfile -t orchestrator-worker-claude:dev deploy/worker-claude
```

- **Base.** The Dockerfile has one stage, `FROM ${PROJECT_BASE}`, with `ARG PROJECT_BASE=orchestrator:dev`. A project layers its toolchain by building an image `FROM orchestrator:dev` that installs it (as root, returning to `node`), then passing that image with `--build-arg PROJECT_BASE=<image>`. The daemon image stays toolchain-free.
- **CLI version.** The build argument `CLAUDE_CODE_VERSION` fixes the version of the Claude Code CLI the image installs; the Dockerfile sets its default to an exact version, `2.1.328`, the one `claude --version` printed in the smoke test's pod. Pass `--build-arg CLAUDE_CODE_VERSION=<version>` for another, and move the default when the smoke test has passed with it. `DISABLE_AUTOUPDATER=1` keeps the installed CLI from replacing itself.
- **Command.** The image sets `ORCH_WORKER_COMMAND` to the Claude template the loop composes for each launch: `claude -p --output-format json --mcp-config {mcpConfig} --strict-mcp-config --dangerously-skip-permissions --model {model} --effort {effort} --no-session-persistence < {brief}`. It has no `{allowedTools}` slot, because a remote brief carries no allow list: the agent runs with every tool call allowed, and the container is the boundary. A deployment that wants an allow list sets its own `ORCH_WORKER_COMMAND`, for instance with `--permission-mode acceptEdits` and `--allowedTools`. The agent reports through the `orchestrator` MCP server named in `--mcp-config`, whose `report` tool pushes the branch (see "The workers").
- **Runner kind.** The image sets `ORCH_WORKER_RUNNER=claude-code`, beside the command, so its workers claim only launches prepared for Claude Code and never a `codex` or `opencode` launch of the same run (see "The workers").
- **Git identity.** `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` are `orchestrator-worker`, `GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_EMAIL` are `worker@orchestrator.local` (the scripted agent's identity), so the agent's `git commit` works.
- **No key.** The image holds no credential for the model and no variable for one. The deployment supplies the key to the worker pod at run time, from a Secret; it is never built into the image.
- The image runs as `node` and its command is `orchestrator-worker`, as in the base worker Deployment. Point the worker Deployment's image at it to run Claude workers.

### The `REPO_URL` contract

`REPO_URL` is an environment variable on the `clone` init container: any URL `git clone` accepts from inside the pod, of a repository that has the integration branch (`main` unless configured) and accepts the daemon's pushes. The base sets a placeholder that fails to clone; an overlay must replace it, for example with a JSON patch on `/spec/template/spec/initContainers/0/env/0`. The clone's `origin` is that URL, and the daemon pushes publications and milestone tags to it. Every start clones it again.

### The kind overlay

`deploy/overlays/kind` adds `git-origin`, a stand-in for the project's real remote until the hardening milestone. On first start its init container commits the files in `fixture/` on `main` and clones them bare to `/srv/git/fixture.git` on its own volume; the container runs `git daemon` with `receive-pack` enabled, so pushes are accepted. The overlay points the daemon at it:

```
REPO_URL=git://git-origin.orch.svc:9418/fixture.git
```

Every fixture file is listed in the overlay's `configMapGenerator`; add a file there when adding one to `fixture/`. The init container copies `fixture/*` and, by name, `fixture/.gitattributes`, which sets `README.md merge=union`: the smoke tasks each append a line to `README.md` from the same base, and the union merge lets the verifier rebase one onto another without a conflict.

The overlay runs a remote run with remote verification. Its own `orchestrator.yaml` replaces the base file in the `orchestrator-config` ConfigMap (`behavior: replace`; kustomize cannot merge inside a file, so it repeats every base key) and adds `runner.access: remote`, `git.workerOriginUrl: git://git-origin.orch.svc:9418/fixture.git` (the in-cluster origin the worker pods clone and push to), `verifier.mode: remote`, so a verifier pod checks every submission, and `capacity: 3`, so the three tasks that depend on `SMOKE` are all parked at once. A patch sets `ORCH_WORKER_AGENT=scripted` on `orchestrator-worker`, so the workers need no model; `replicas` stays 0 until the smoke test scales it. Another patch runs `orchestrator-verifier` at one replica with `ORCH_VERIFIER_BACKOFF_MAX_MS=2000`, so an idle verifier asks for a job at least every two seconds.

The fixture's check is `npm test`, which runs `fixture/test.js`. It waits 5 seconds, so the smoke's process probe sees it run, then fails when `README.md` is missing, or when a line of `README.md` starts with `- SMOKE-M5-BREAK ` (printing `fixture check: README.md names a task that breaks the check`), and prints `fixture check: ok` otherwise. git-origin seeds the fixture only when its repository does not exist, so a cluster kept from before this check came keeps the old one.

The overlay's `graph.yaml` holds one ready task, `SMOKE`, and three that depend on it: `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`. It is not mounted: the smoke test sends it with `PUT /v1/graph`, and the daemon, in pull mode, prepares a launch for `SMOKE` and parks it as claimable, which is what the smoke test looks for. `graph-m5.yaml` is a graph fragment, not mounted either: two more tasks on `SMOKE`, `SMOKE-M5-PASS` and `SMOKE-M5-BREAK`, which the smoke's M5 step sends after `graph.yaml`.

`deploy/overlays/kind-claude` is the kind overlay with Claude workers. It takes `deploy/overlays/kind` whole and adds one strategic merge patch on `orchestrator-worker`: the image `orchestrator-worker-claude:dev` (see "Claude worker image", which sets `ORCH_WORKER_COMMAND`), `ORCH_WORKER_AGENT=command` in place of `scripted`, and `ANTHROPIC_API_KEY` from the Secret `anthropic-api-key`, key `ANTHROPIC_API_KEY`. It renders no Secret and sets no `ORCH_WORKER_COMMAND`; `replicas` stays 0, and every other resource is the kind overlay's, so applying it over the kind overlay restarts no daemon. Its `real-task.yaml` is not a resource but a graph fragment: one node, `SMOKE-REAL`, which depends on `SMOKE`, asks for one given line at the end of `README.md`, has one acceptance criterion and names no `model`, so its launch runs on the run's default (`runner.claude.model` and `effort`, by default `claude-opus-5-5` at `medium`). The smoke test's real-agent step creates the Secret, applies this overlay and sends `graph.yaml`, `graph-m5.yaml` and `real-task.yaml`, in that order: `SMOKE-M5-PASS` is done by then, and a graph that drops a started node is refused.

Every Deployment of the kind overlay (the daemon, git-origin, the workers and the verifier) runs `orchestrator:dev`, so a kind cluster needs only that image and the CloudNativePG operator:

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
deploy/smoke.sh --break pvc         # falsify one drill assertion on purpose (pvc, claimable or restart); exits 1
deploy/smoke.sh --fresh --real-agent ~/keys/anthropic   # also run the real-agent step, with the key in that file
```

These are the only arguments: `--dry-run`, `--fresh`, `--break pvc|claimable|restart` and `--real-agent <key file>`. Anything else, or another `--break` value, prints usage and exits 2. `--real-agent` takes the path of a file that holds the Anthropic key and nothing else. The path is read against the caller's working directory. The file must be a readable regular file, not a symbolic link, and must not lie inside the repository (its directory's physical path, `cd -P`, is not the repository root or below it). Without a value, or with a path that breaks that rule, the script prints one line on stderr and exits 2 before any step and before any tool is called. With `--dry-run` it checks the path and does not read the file.

A run without `--fresh` continues the kept cluster only while its run is unfinished. Before its first step, after every argument is checked, the script reads `/v1/status` through the API server's Service proxy (`kubectl get --raw /api/v1/namespaces/orch/services/orchestrator:api/proxy/v1/status`, no port-forward; `finished_run_check`). When the run is finished from an earlier full pass, nothing is left to claim, so the script prints one line on stderr that names `--fresh` and exits 2 before its first step, with the cluster unchanged. `--fresh` starts over on a new cluster and skips the check (`smoke: skip: finished-run check (--fresh starts a new cluster)`). No answer (no cluster, namespace or daemon), or a `finished` that is not `true`, lets the script go on; a kept cluster whose run is unfinished, for example after a failed pass, reruns from step 1. Under `--dry-run` the check is the step `+ finished_run_check`, printed first and not run.

The steps run in this order:

1. `docker build -t orchestrator:dev .`
2. `kind load docker-image orchestrator:dev --name "$KIND_CLUSTER"`
3. `kubectl apply --server-side -f "$CNPG_MANIFEST"` (the CloudNativePG operator), then its rollout
4. `kubectl apply -k deploy/overlays/kind`
5. `kubectl wait` for `cluster/postgres` to be Ready, then `kubectl rollout status` for `git-origin`, for `orchestrator` and for `orchestrator-verifier`; from then on the verifier pod checks every submission
6. `kubectl port-forward service/orchestrator` to `127.0.0.1:$LOCAL_PORT` (default 18080), then wait for `/healthz`
7. `PUT /v1/graph` with the overlay's `graph.yaml`, which must be accepted
8. The assertions, polled against `/v1/status` until they hold or `STATUS_TIMEOUT_S` (default 120) seconds pass

It asserts:

- M1: `runner.mode` is `pull` and `claimable` is non-empty. The daemon runs in the cluster in pull mode and has parked a launch for the overlay's `SMOKE` task.
- M2: no volume of the daemon pod is backed by a claim (`persistentVolumeClaim` or `ephemeral`), whatever the claim is called. The script reads the pod's volumes, not the claim names in the namespace. Postgres and `git-origin` keep their own claims.
- M2 restart drill. The graph has `SMOKE` and three tasks that depend on it. The script works `SMOKE` with one worker pod, `smoke-worker` (`kubectl run` of `orchestrator-worker` with `ORCH_WORKER_AGENT=scripted`, `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`): it claims the launch with `access: remote`, clones git-origin, appends a line to `README.md`, pushes the launch branch, submits with its sha, and exits. The step requires the pod to succeed and its log to show `report accepted` for `SMOKE`; the pod is kept for the M3 log assertion. The script waits until the verifier pod has checked `SMOKE` and the daemon has published it to origin and `SMOKE-PARKED` is claimable, then until `SMOKE-M3-A` and `SMOKE-M3-B` are claimable too, so the claimable set holds still through the drills. It then records three things:
  - from the API: the claimable launches as launch id and task id, the task states, `latestSeq`, the integration head (the `publishedSha` of `SMOKE`'s transition to `done`), and the daemon pod's uid. `/v1/status` lists claimable tasks only, so the launch ids come from `/v1/events`: a launch is claimable when its latest `launch.claimable`, `launch.claimed`, `launch.released`, `launch.ended`, `launch.revoked` or `launch.failed` event is `launch.claimable`, and those launches' tasks must equal `/v1/status` `claimable`;
  - through `psql` on the CloudNativePG pod: `select status, count(*) from orchestrator.launches where run_id = ... group by 1`, the claimable launches as launch id, task id and `md5(token)`, and the task states;
  - a check that the API and `psql` agree.

  Then it deletes the daemon pod. After the rollout, the new pod runs on a fresh clone and an empty run directory. `/readyz` passes before the daemon's startup recovery runs, so the script first waits for recovery (`drill: startup recovery settled every recorded claimable launch`). What that means depends on the run's access, which the script reads from the kind overlay's `orchestrator.yaml`. Under local access, every recorded claimable launch has a recovery event (`launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed`) after the recorded sequence. Under remote access, the kind overlay's setting, recovery keeps a remote parked launch as it is: it has no worktree on the daemon to prepare again, so recovery records none of those events for it. The script then waits until `/readyz` passes, `/v1/status` serves a `latestSeq` at least the recorded one, and the claimable set reads consistently from `/v1/events` and `/v1/status`, and fails if any of those four events after the recorded sequence names a recorded claimable launch. The unchanged launch id and token checks below carry the proof that each launch is still parked. It asserts that:
  - the pod's uid is new, and the same `graphRev` is served;
  - the claimable launches are unchanged by launch id (API) and by launch id and token (`psql`), and so are the task states and the launch counts. A launch replaced by a new one for the same task fails `drill: claimable set unchanged (API)`;
  - origin's `main` and the clone are at the recorded head, and origin's history carries the `Orchestrator-Task: SMOKE` commit;
  - `drill: one launch.reprepared per claimable launch`: under local access exactly one `launch.reprepared` event per claimable launch follows the recorded sequence; under remote access none follows it;
  - the new daemon pod still mounts no claim.
- M2 Postgres-outage drill. The script freezes every `postgres` process in the instance pod with SIGSTOP for `OUTAGE_S` seconds (default 10). One write stays pending meanwhile: a claim for a task that does not exist, whose response waits for durability. Just before the thaw, the script checks that this request is still running with no answer and that `storePendingBatches` is above zero. While Postgres is frozen, `/readyz` must answer 503 at least once, and only 200 or 503; curl's `000` (no answer) fails the assertion. `/v1/status` must answer with `storeLagMs` rising. After SIGCONT, the lag must return to zero, `/readyz` must pass, the write must answer 404, and the daemon pod's uid and restart count must be unchanged.

  The drill freezes Postgres rather than scaling it to zero. The journal sink never reconnects, and a lost session is fatal, so scale-to-zero restarts the daemon by design. A NetworkPolicy does not stall the session either, because kindnet enforces policies only on new connections. Keep `OUTAGE_S` well under 30: CloudNativePG's liveness probe (3 × 10s) restarts a frozen Postgres, which ends the session and so the daemon.
- M2 Postgres-restart drill. The script records `latestSeq`, the claimable launches and task states (API and `psql`), the daemon pod's uid and its restart count. Under local access a container restart keeps the pod's `emptyDir`, so the parked worktrees survive it and startup recovery would leave no trace. The script therefore removes `.orchestrator/brief.json` from each claimable launch's worktree in the pod; recovery prepares those launches again and records `launch.reprepared`, which is what the script waits for. Under remote access a parked launch has no worktree on the daemon, so the script removes nothing and says so. It starts following the daemon container's log into a file (`kubectl logs -f`, which ends when that container exits), then deletes the Postgres pod and waits until it is gone. CloudNativePG's smart shutdown waits for open sessions, the daemon's included, for up to the Cluster's `smartShutdownTimeout` (180s by default), so this step takes about three minutes. The daemon then loses its session and the run lock and exits. The script asserts that:
  - the daemon container restarts within `PG_EXIT_TIMEOUT_S` (default 60) seconds of the old Postgres pod being gone;
  - it restarted because the session was lost: the container's last termination, read when the restart is first seen, is exit code 1 with reason `Error` (an out-of-memory kill reads `OOMKilled`; a probe kill or a SIGTERM ends with 0, 137 or 143, or with 1 when the shutdown left batches unflushed, which is why the last log line is checked too), and the last line the exited container logged is `store fatal: exiting` with `reason: fenced`. The log is followed from before the deletion because the container crash-loops until Postgres is back: `kubectl logs --previous` and the last termination may already describe a later start that could not connect;
  - within `PG_READY_TIMEOUT_S` (default 120) seconds of the old Postgres pod being gone, the pod is Ready and `/readyz` answers 200 through a new port-forward (measured on kind: about 12s);
  - within `STATUS_TIMEOUT_S`, recovery has settled, as in the restart drill (`pg-restart: startup recovery prepared every claimable launch again` and `pg-restart: one launch.reprepared per claimable launch`). Under local access it has recorded a `launch.reprepared` for every recorded claimable launch after the recorded sequence, exactly one each; under remote access no recovery event names a recorded claimable launch and no `launch.reprepared` follows the recorded sequence. `/readyz` passes before recovery runs, so the comparisons wait for this and not for a fixed time;
  - it is the same pod, and the claimable launches (ids, and tokens through `psql`) and the task states are unchanged.
- Last of the drills, a claim of `SMOKE-PARKED` with `access: remote` must return a launch id and token (compared by md5 in `psql`) recorded before the first restart. The script then releases that launch.
- M3: the worker Deployment. The script scales `orchestrator-worker` to 2, waits for the rollout, and follows each worker pod's log into a file from its first line (a worker exits once the run is finished and its container restarts, so a later `kubectl logs` would show the new container). The two pods claim the parked launches of `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`, run the scripted agent, push and submit; the verifier pod checks each and the daemon publishes it. It asserts, within `FINISH_TIMEOUT_S` (default 600) seconds:
  - `M3: the run is finished`: `/v1/status` `finished` is `true`;
  - `M3: every smoke task is on origin's integration branch`: the first-parent history of origin's `main` carries an `Orchestrator-Task` trailer for each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`;
  - `M3: worker logs show one accepted report per task`: the logs of `smoke-worker` and of the followed worker pods hold exactly one `worker <id> report accepted <launchId> <taskId>` line for each of those four tasks, and none for another.
- M4 step, block A, between the final claim and the M3 scale-up. The script builds the Claude worker image from `deploy/worker-claude/Dockerfile` as `WORKER_IMAGE` (default `orchestrator-worker-claude:dev`), with `PROJECT_BASE` set to `IMAGE`, and loads it into the kind cluster. `M4: the Claude worker image runs the claude CLI` runs `sh -c 'claude --version && test -w "$HOME"'` in a one-shot pod of that image, prints the pod's log, and holds when the pod succeeds with a non-empty log. Then the termination step works `SMOKE-M3-A` with a one-shot pod, `smoke-term`, made as `smoke-worker` is, with `ORCH_WORKER_TASK=SMOKE-M3-A`, `ORCH_WORKER_MAX_LAUNCHES=1`, `ORCH_WORKER_AGENT=command` and a stand-in agent as `ORCH_WORKER_COMMAND`. The stand-in appends a line to `README.md`, prints one Claude result object with token counts and `total_cost_usd` 0.01 on standard output, prints `smoke-term-ready` on standard error, and sleeps; no model runs. When the pod's log shows the marker, the script deletes the pod with `--grace-period=120` (the worker Deployment's grace; a `kubectl run` pod has 30 seconds), waits until it is gone, and prints its log. It asserts:
  - `M4: deleting the worker pod mid-task releases its launch with kept true`: the `launch.released` event of `SMOKE-M3-A` with `workerId` `smoke-term` has `kept: true`, `reason` `podTerminating`, and a `headSha` that is a commit in git-origin's repository;
  - `M4: usage printed by the terminated agent is recorded`: `/v1/status` `cost.byTask["SMOKE-M3-A"]` is above zero within `STATUS_TIMEOUT_S`. The figure is the stand-in's, not a model's.

  The block ends when `SMOKE-M3-A` is claimable again, and the M3 step works it from the kept head. A leftover `smoke-term` pod is deleted first. When `SMOKE-M3-A` then has no claimable launch (a rerun on a kept cluster where it was already worked), the termination step is skipped and its two assertions print `smoke: skip:` with the reason `SMOKE-M3-A is not claimable`. On exit the script deletes a `smoke-term` pod it started that still exists, and waits until it is gone. One cluster allows three kept releases of `SMOKE-M3-A` (`daemon.maxKeptReleases`); use `--fresh` after that.
- M4 step, block B, after the M3 assertions: `M4: every integration commit carries its Orchestrator-Launch trailer`. Every first-parent commit of origin's `main` with an `Orchestrator-Task` trailer also has an `Orchestrator-Launch` trailer, and its value is the `launchId` of an `agent.report` event of that task.
- M5 step, after block B: the verifier pool. It needs a cluster made with `--fresh` after `graph-m5.yaml` and the breaking fixture check came: a kept older cluster's fixture would pass `SMOKE-M5-BREAK`. The script starts a process probe, sends `graph.yaml` followed by `graph-m5.yaml` with `PUT /v1/graph` (the finished run takes the two new tasks), and restarts the worker Deployment (`kubectl rollout restart`, then its rollout), since the workers exited when the run finished and sit in a growing restart delay. The probe runs rounds until it is stopped: one sample of the daemon container, then one of each running verifier pod. A sample is one `kubectl exec` that reads, twice and one second apart, the processes whose parent is the container's pid 1 and that are not zombies, and reports each one found in both reads whose command name at the second read is not `git` (a child caught between fork and exec still has its parent's name at the first read). A sample whose exec fails, or whose pid 1 is not `/usr/local/bin/orchestrator` (or `/usr/local/bin/orchestrator-verifier`), is printed and not counted. It asserts, in this order:
  - `M5: orchestrator, orchestrator-worker and orchestrator-verifier are deployed`: the three Deployments exist and the verifier reports one ready replica;
  - `M5: SMOKE-M5-PASS is published`: within `FINISH_TIMEOUT_S`, `/v1/status` lists it as done and origin's `main` carries its `Orchestrator-Task` trailer;
  - `M5: SMOKE-M5-BREAK is blocked after its attempts`: within `FINISH_TIMEOUT_S`, `/v1/status` lists it as blocked (after its second failed check, not its first), its overlay row in `psql` (`pg_m5_reason`) holds the message `attempts exhausted after 2: checkFailed`, and origin's `main` carries no trailer for it. The script then stops the probe;
  - `M5: the check ran in a verifier pod and never under the daemon`: no daemon sample reported a child, at least one verifier sample did, at least five daemon samples were taken, and the slowest round was shorter than the fixture check's 5 seconds, so a check under the daemon could not fall between two samples. It prints the three counts and the slowest round, and fails with a line naming the slowest round when that round took 5 seconds or more. When the script stops earlier in the M5 step, `cleanup` prints the same summary on stderr before it removes the probe's files;
  - `M5: the failed jobs are checkFailed with the check's output`: `orchestrator.verifier_jobs` in `psql` (`pg_m5_jobs`) has exactly two rows for `SMOKE-M5-BREAK` in this run, each `failed`, with `failureKind` `checkFailed` and an output that holds the fixture's breaking line;
  - `M5: verifier logs show the check`: the verifier pods' logs (with their restart counts) hold a `check` and a `verified` line for `SMOKE-M5-PASS` followed by `fixture check: ok`, and two `check` and two `checkFailed` lines for `SMOKE-M5-BREAK`, whose job ids are the two rows', each followed by the breaking line. It reads the rows itself and fails unless there are exactly two, so no rows and no lines never pass;
  - `M5: the daemon pod made no verification worktree`: `<runDir>/verify` does not exist in the daemon container;
  - `M5: the run is finished again`: the script cancels `SMOKE-M5-BREAK` (`POST /v1/tasks/SMOKE-M5-BREAK/cancel`), and `/v1/status` says `finished: true` within `STATUS_TIMEOUT_S`, so a rerun on that cluster is refused by the finished-run check.

  A pass that failed in or after the M5 step once `SMOKE-M5-PASS` or `SMOKE-M5-BREAK` had started is followed by one with `--fresh`. While the run is unfinished, the next pass's step 7 sends `graph.yaml` alone, which drops a started node and is refused; once it is finished, the finished-run check refuses the pass. The probe covers only the M5 step, and the missing `<runDir>/verify` only the time since the restart drill created the daemon pod.
- The real-agent step, last, only with `--real-agent <key file>`. It creates or replaces the Secret `anthropic-api-key` in namespace `orch` with the one key `ANTHROPIC_API_KEY`, the file's content with its line ends removed; the key reaches `kubectl` on standard input only, and the script prints the path, never the key. It scales `orchestrator-worker` to 0 and waits until no worker pod is left (a scripted worker could otherwise claim the new task), applies `deploy/overlays/kind-claude`, sends `graph.yaml`, `graph-m5.yaml` and `real-task.yaml` with `PUT /v1/graph` (without `graph-m5.yaml` the upload would drop the done `SMOKE-M5-PASS` and be refused), waits until `SMOKE-REAL` is claimable, and scales `orchestrator-worker` to 1. One Claude worker then works `SMOKE-REAL` on the run's default model. It asserts:
  - `M4: the real task is done`, within `REAL_TIMEOUT_S` (default 900) seconds;
  - `M4: the real task's launch cost is above zero`: `cost.byTask["SMOKE-REAL"]` within `STATUS_TIMEOUT_S`, since the worker posts the usage after the agent has exited;
  - `M4: the real task's commit carries its Orchestrator-Launch trailer`, the block B rule for `SMOKE-REAL`'s commit.

  The model's cost is the caller's: the step spends one launch of the run's default model on a one-line task, bounded by `REAL_TIMEOUT_S`. On exit a run with `--real-agent` scales `orchestrator-worker` to 0, so no agent keeps spending after the script ends; the worker Deployment then runs the Claude image, so run the next smoke on that cluster with `--fresh`. On a cluster whose run is finished from an earlier pass, use `--fresh` with `--real-agent` too. The step changes the worker pool, so a later milestone adds its steps above it. Without `--real-agent` its three assertions print `smoke: skip: <name> (needs --real-agent)`, also in a dry run.

`--break` falsifies one assertion on purpose. The script must then fail at that assertion, with every earlier one passing:

- `--break pvc` creates a claim named `data-smoke-break` and mounts it into the daemon container with a Deployment patch. It waits for that rollout's recovery and then takes the snapshot. The restart drill fails with `smoke: FAIL: drill: the daemon pod mounts no volume claim`. On exit the script removes the volume and the mount from the Deployment, which rolls the daemon again, and deletes the claim.
- `--break claimable` claims `SMOKE-PARKED`'s launch (with `access: remote`) after the snapshot and before the restart. Under remote access recovery keeps that claim live, and under local access it ends the launch and parks a new one for the same task; either way the recorded launch is no longer claimable, so the run fails with `smoke: FAIL: drill: claimable set unchanged (API)`.
- `--break restart` stops the daemon with SIGTERM (`kill -TERM 1` in its container) in place of deleting the Postgres pod. The daemon shuts down and exits 0, since every batch is durable at that point of the drill; with unflushed batches it would exit 1. Its container restarts, so the restart count rises as in a real drill. The run fails with `smoke: FAIL: pg-restart: the daemon exited because its Postgres session was lost`.

Each assertion prints `smoke: pass: <name>`. The first one that does not hold prints `smoke: FAIL: <name>`, and the script exits 1. A full pass ends with `smoke: ok`. Nothing is skipped without a line: a check or step that does not run prints `smoke: skip: <name> (<why>)`. Under `--dry-run` every assertion prints one such line after its command, except the three real-agent assertions: without `--real-agent` they print `smoke: skip: <name> (needs --real-agent)` with no command, in a dry run or not. On a kept cluster whose run is unfinished, a rerun prints one for the worker step when `SMOKE` is already submitted or done, and `--break restart` prints one for the Postgres pod deletion it replaces. The script reads no `TEST_DATABASE_URL` (that variable belongs to `npm test`), and no environment variable turns a check off. `PUBLISH_TIMEOUT_S` (default 300) bounds the wait for the publish.

Every `kubectl` call that talks to a cluster passes `--context "$KUBE_CONTEXT"`. Its only accepted value is `kind-$KIND_CLUSTER`, the default. Any other value exits 2 before the first step, so the image always goes to the cluster being tested. The script leaves the current kubectl context as it found it. The exception is `kind create cluster` under `--fresh`, which makes the new cluster current. So `--fresh` reads `kubectl config current-context` first, and afterwards runs `kubectl config use-context` with that value, or `kubectl config unset current-context` if none was set. These three `kubectl config` calls are the only ones without `--context`.

Under local access `--break claimable` spends no attempt of `SMOKE-PARKED`: recovery ends the claimed launch whose worktree is gone with `worktreeLost`, and the task is admitted again with its attempts unchanged. Under remote access the break's claim stays live until its lease expires, and is then handled as any expired remote claim; run the next smoke with `--fresh`. The final claim releases its launch without progress, which spends no attempt. `IMAGE`, `ROLLOUT_TIMEOUT` (default `300s`) and `CNPG_MANIFEST` (the operator release to install) can also be overridden. The script exits non-zero at the first step that fails. `test/host/smoke.test.ts` runs the dry run, with every tool stubbed out, and checks the order of the steps.
