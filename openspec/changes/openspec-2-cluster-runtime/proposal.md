## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `cluster-runtime`, 13 of the 20 requirements are over the limit. This change splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-171).

## What Changes

- Thirteen requirements are MODIFIED. Each keeps its header and every scenario, with names and text unchanged, and its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Bind host and advertised URL | 682 | 388 | 2 | 2 |
  | Probes | 629 | 408 | 4 | 2 |
  | Daemon image | 757 | 419 | 2 | 3 |
  | Reference manifests | 2028 | 230 | 2 | 6 |
  | Smoke test | 1790 | 459 | 7 | 5 |
  | Smoke worker step | 1001 | 471 | 2 | 3 |
  | Smoke restart drill | 1921 | 469 | 7 | 5 |
  | Smoke assertions are named | 632 | 414 | 2 | 1 |
  | Smoke test options | 1290 | 295 | 5 | 3 |
  | Deployment run id | 713 | 283 | 3 | 1 |
  | Smoke Postgres-restart drill | 1287 | 377 | 7 | 2 |
  | Worker Deployment | 1056 | 315 | 2 | 3 |
  | Smoke M3 step | 885 | 426 | 2 | 2 |

- 38 requirements are ADDED, one for each behavior moved out of those descriptions. Each name starts with the name of the MODIFIED requirement its text comes from, followed by a colon, and `cluster-runtime` has no requirement of that name at the base commit 941ee02. Each has a description of at most 500 characters (the longest is 486) that holds SHALL or MUST, and at least one scenario of its own with a WHEN and a THEN step. Each scenario states behavior the code has at the base commit. The file (and test) that shows it is named under "Where each new scenario comes from".
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened. The 13 original descriptions hold 66. The cut descriptions hold 31 and the ADDED descriptions 53, 84 in all. The extra ones come from lead-ins repeated in split sentences and from SHALL given at a joint, both listed below.
- Requirements under 500 characters are not touched. Nothing outside this change directory changes. The fixes of #165 (cluster-runtime wording) are not made here; the text is kept as it is.

### Splits, lead-ins and SHALL at a joint

Sentences are numbered from 1 in each original description; a list item counts as one sentence. Five original sentences are longer than 500 characters on their own, and each is split at its own joints:

- **"Reference manifests" s1 (1206 characters)** is split at its semicolons. The lead-in "`deploy/base` SHALL be a kustomization rendering" is repeated in each part. Four items stay in the MODIFIED description in their order: the Namespace, the CloudNativePG `Cluster`, the Service and "and the worker Deployment ...". The ConfigMap item moves to "Reference manifests: base ConfigMap". The Deployment item (about 700 characters) is still over 500, so it is split again between its comma items, with the lead-in "`deploy/base` SHALL be a kustomization rendering a Deployment `orchestrator` with" repeated. The Secret item and the "no `DATABASE_URL`, ... no variable read from a Secret" run stay together in "Reference manifests: store URL file". Every other item of the Deployment, in its order, goes to "Reference manifests: daemon Deployment". s2 ("The run lock, not the strategy, prevents two writers.") has no SHALL. It moves unchanged with the strategy item that it qualifies.
- **"Reference manifests" s3 (548 characters)** has no semicolon. It is one list of three SHALL verbs, split between its items. The first part ends "..., and SHALL patch `REPO_URL` to it.": the joint's ", SHALL patch" becomes ", and SHALL patch". The second part starts with the repeated subject: "`deploy/overlays/kind` SHALL make the run remote: ...".
- **"Smoke test" s1 (645 characters)** has no semicolon. It is split between the items of its "in order:" list, before "port-forward the Service". The first part ends after "wait for `cluster/postgres`, `git-origin` and `orchestrator`" with a period, and stays in the MODIFIED description. The second part takes the lead-in "`deploy/smoke.sh` SHALL in order:" and goes to "Smoke test: port-forward, graph upload and M1 poll". No other words are added. The order across the two parts is still stated: the kept scenario "Dry run prints the steps in order" gives the full order, and the new scenario of the second part says that its steps come after the rollout wait of `deployment/orchestrator`.
- **"Smoke restart drill" s8 (505 characters)** has no semicolon. It is split at its clause joint ", so". The exception "Under remote access," is repeated at the head of the second part, so each part is right when read alone. In the second part, "any of those four events" is made explicit as "any `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event". The first part has no SHALL of its own. Its verbs get SHALL at the joint: "keeps" becomes "SHALL keep" and "records none of those events" becomes "SHALL record none of the `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` events". This is because the only SHALL sentence that could carry it within 500 characters is the second part, and that part already takes 419.
- **"Worker Deployment" s1 (844 characters)** is split at its semicolons. The three items after the first semicolon take the lead-in "`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with" and go to "Worker Deployment: environment and clone cache". The first item (613 characters) is still over 500, so it is split between its comma items before "set `terminationGracePeriodSeconds: 120`". Its first part stays in the MODIFIED description, with ", run as uid" becoming " and run as uid" at the joint. Its second part takes the lead-in "`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` whose pods" and goes to "Worker Deployment: termination".

Moved text without SHALL or MUST of its own moves with the SHALL sentence of the same behavior when one can carry it within 500 characters:

- "Reference manifests" s2 moves with the strategy item.
- "Smoke test" s7 ("M1 asserts ...") moves with the status poll, whose assertions it names.
- "Smoke test" s8 ("M2 asserts ...") stays with the steps.
- "Smoke restart drill" s2 and s4 stay in the snapshot description.
- "Smoke restart drill" s7 moves with s6, which it defines.
- "Smoke restart drill" s9 moves with the first part of s8. Both say what keeps a remote parked launch parked and what proves it.
- "Smoke test options" s2 stays with s1.
- "Smoke test options" s3 and s4 move with s6.
- "Smoke Postgres-restart drill" s3 moves with s2.
- "Smoke Postgres-restart drill" s7 moves with s6. Both are about the drill's recovery comparisons.
- "Worker Deployment" s3 stays.

Where no SHALL sentence of the same behavior can carry the text, it gets SHALL plus its own verb at the joint, and nothing else changes:

- "Probes" s2: "is not ready" becomes "SHALL NOT be ready". The only other SHALL sentence that could carry it, s3, states another behavior (no token, no idle activity). s1, which it qualifies, stays in the MODIFIED description, where s1 and s2 together would take 537 characters.
- "Smoke test" s9 and s10 (the M3 and M4 sentences, 295 characters together):
  - "scales" becomes "SHALL scale" and "asserts" becomes "SHALL assert".
  - "checks" becomes "SHALL check" and "runs" becomes "SHALL run".
  - No SHALL sentence about the milestone steps has room for them. The MODIFIED description takes 459 characters, and the poll part takes 387.
- "Smoke restart drill" s5: "The script reads" becomes "`deploy/smoke.sh` SHALL read". The SHALL sentences that have room (s3, at 344 characters) state other behaviors. Moved with s6 and s7, the three would take more than 520 characters.
- "Smoke test options" s5: "sends" becomes "SHALL send" and "prints" becomes "SHALL print". s6 carries s3 and s4 at 486 characters and has no room for a third `--break` sentence.
- "Smoke restart drill" s8, first part, as described above.

Bullets:

- "Smoke M3 step" keeps its list lead-in "It SHALL then assert, with these names:" and its first bullet in the MODIFIED description. That bullet is now the list's last item, so its closing ";" becomes ".".
- The second and third bullets carry no SHALL of their own. Each moves with its list's lead-in before its unchanged text: "`deploy/smoke.sh` SHALL then assert, with these names:", where "It" is made explicit. Its list marker "- " is dropped, as in `2026-11-19-openspec-2-operator-control-1`. The second bullet's closing ";" becomes ".". In the third bullet, "each of those four tasks" is made explicit as "each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`".

### Moved sentences

For each MODIFIED requirement, every original sentence is listed below with where it now is. "Unchanged" means word for word. Every changed or split sentence is quoted first as it was, then as each part now reads, with the kind of change and the requirement that holds the part.

#### Bind host and advertised URL

- s1, unchanged, stays in "Bind host and advertised URL": "The configuration SHALL accept `apiBind`, a non-empty string defaulting to `127.0.0.1`, and `apiBaseUrl`, an optional URL."
- s2, unchanged, stays in "Bind host and advertised URL": "The API server SHALL bind to `apiBind` and SHALL advertise `apiBaseUrl` without a trailing slash when it is set, else `http://<apiBind>:<port>` with an IPv6 bind bracketed."
- s3, unchanged, "Bind host and advertised URL: where the advertised URL is used": "The advertised URL SHALL be the one stored in kv and `daemon.json`, embedded in briefs, returned by claims, and reported by `status`."
- s4: "Both keys SHALL be file keys only: they are read at start and SHALL NOT be in the runtime override set, so `configure` and `PUT /v1/config` do not accept them."
  - reference made explicit, "Bind host and advertised URL: file keys only": "`apiBind` and `apiBaseUrl` SHALL be file keys only: they are read at start and SHALL NOT be in the runtime override set, so `configure` and `PUT /v1/config` do not accept them."
- s5, unchanged, stays in "Bind host and advertised URL": "With neither key set the daemon SHALL behave exactly as before: loopback bind, loopback URL."

#### Probes

- s1, unchanged, stays in "Probes": "The daemon SHALL answer `GET /healthz` with 200 `{ ok: true }` whenever the process serves, and `GET /readyz` with 200 `{ ok: true }` only when the store answers a query and reports itself ready, the repository path is readable, and the integration branch resolves to a commit, else 503 `{ ok: false, reasons }` with one entry per failed check (an unreadable repository also reports the branch as unchecked)."
- s2: "A journaled store is not ready while its lag has been above zero for longer than one flush retry, and once its run lock is lost."
  - SHALL given at the joint ("is not ready" becomes "SHALL NOT be ready"), "Probes: journaled store readiness": "A journaled store SHALL NOT be ready while its lag has been above zero for longer than one flush retry, and once its run lock is lost."
- s3: "Neither route SHALL require a token, and neither SHALL count as activity for the idle exit."
  - reference made explicit, "Probes: no token and no idle activity": "Neither `/healthz` nor `/readyz` SHALL require a token, and neither SHALL count as activity for the idle exit."

#### Daemon image

- s1, unchanged, stays in "Daemon image": "The repository SHALL carry a multi-stage `Dockerfile` on `node:22-slim` whose build stage compiles `dist/` and whose final stage holds `git`, `openssh-client`, `ca-certificates`, the built `dist/src`, and production dependencies only, runs as the unprivileged `node` user, and puts `orchestrator` (the default command), `orchestrator-ctl` and `orchestrator-worker` (the remote worker loop, specs/worker-pool) on `PATH`."
- s2: "It SHALL carry no project toolchain beyond Node; workers and verifiers get their own images."
  - reference made explicit, "Daemon image: no project toolchain": "The `Dockerfile`'s final stage SHALL carry no project toolchain beyond Node; workers and verifiers get their own images."
- s3, unchanged, "Daemon image: build context": "A `.dockerignore` SHALL keep `node_modules`, `dist`, `.git`, run data, SQLite files, test fixtures, and the plugin's `node_modules` out of the build context."
- s4, unchanged, "Daemon image: deploy notes": "`deploy/README.md` SHALL name the image, the build command, and the three entrypoints."

#### Reference manifests

- s1: "`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a hash-suffixed ConfigMap `orchestrator-config` holding only `orchestrator.yaml` (`runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl` naming the Service, `store.kind: postgres`, `store.urlFile: /var/run/secrets/orchestrator/postgres/uri`, `git.pushIntegration: true`); a CloudNativePG `Cluster` `postgres`; a Deployment `orchestrator` with strategy `Recreate`, an `emptyDir` at `/data` and no volume claim, an init container `clone` that clones `REPO_URL` into `/data/repo`, a daemon container running `orchestrator --repo /data/repo` with `ORCH_HOME=/data/home` and `ORCH_LOG_FORMAT=json`, the Secret `postgres-app` key `uri` mounted read-only as the file `uri` under `/var/run/secrets/orchestrator/postgres` (mode 0440, readable through the pod's `fsGroup`), no `DATABASE_URL`, no `DATABASE_URL_FILE`, no variable starting with `PG` and no variable read from a Secret, the ConfigMap's file mounted into the clone with `subPath`, and probes on `/healthz` and `/readyz`; a ClusterIP Service `orchestrator` on port 8080; and the worker Deployment `orchestrator-worker` (see "Worker Deployment")."
  - split (semicolon list: the Namespace, Cluster, Service and worker Deployment items stay, in their order), stays in "Reference manifests": "`deploy/base` SHALL be a kustomization rendering a Namespace `orch`; a CloudNativePG `Cluster` `postgres`; a ClusterIP Service `orchestrator` on port 8080; and the worker Deployment `orchestrator-worker` (see "Worker Deployment")."
  - split (semicolon list item, lead-in repeated), "Reference manifests: base ConfigMap": "`deploy/base` SHALL be a kustomization rendering a hash-suffixed ConfigMap `orchestrator-config` holding only `orchestrator.yaml` (`runner.mode: pull`, `daemon.idleExitMs: 0`, `apiBind: 0.0.0.0`, `apiPort: 8080`, `apiBaseUrl` naming the Service, `store.kind: postgres`, `store.urlFile: /var/run/secrets/orchestrator/postgres/uri`, `git.pushIntegration: true`)."
  - split (Deployment item split between its comma items, lead-in through "a Deployment `orchestrator` with" repeated; the Secret and environment items move out), "Reference manifests: daemon Deployment": "`deploy/base` SHALL be a kustomization rendering a Deployment `orchestrator` with strategy `Recreate`, an `emptyDir` at `/data` and no volume claim, an init container `clone` that clones `REPO_URL` into `/data/repo`, a daemon container running `orchestrator --repo /data/repo` with `ORCH_HOME=/data/home` and `ORCH_LOG_FORMAT=json`, the ConfigMap's file mounted into the clone with `subPath`, and probes on `/healthz` and `/readyz`."
  - split (Deployment item split between its comma items, lead-in repeated; holds the Secret mount and the environment items), "Reference manifests: store URL file": "`deploy/base` SHALL be a kustomization rendering a Deployment `orchestrator` with the Secret `postgres-app` key `uri` mounted read-only as the file `uri` under `/var/run/secrets/orchestrator/postgres` (mode 0440, readable through the pod's `fsGroup`), no `DATABASE_URL`, no `DATABASE_URL_FILE`, no variable starting with `PG` and no variable read from a Secret."
- s2, unchanged, "Reference manifests: daemon Deployment": "The run lock, not the strategy, prevents two writers."
- s3: "`deploy/overlays/kind` SHALL add a `git-origin` serving a bare repository seeded from `fixture/` with `receive-pack` enabled, SHALL patch `REPO_URL` to it, and SHALL make the run remote: its own `orchestrator.yaml` replaces the base file in `orchestrator-config` (`behavior: replace`), holding every base key plus `runner.access: remote`, `git.workerOriginUrl` set to the `git-origin` Service URL, and `capacity: 3` (so every dependant of `SMOKE` is parked before the drills), and a patch sets `ORCH_WORKER_AGENT=scripted` on `orchestrator-worker`."
  - split (split between its SHALL items, "and" added before "SHALL patch"; lead-in "`deploy/overlays/kind` SHALL" repeated in the second part), "Reference manifests: kind overlay origin": "`deploy/overlays/kind` SHALL add a `git-origin` serving a bare repository seeded from `fixture/` with `receive-pack` enabled, and SHALL patch `REPO_URL` to it."
  - split (second part: lead-in "`deploy/overlays/kind`" repeated before "SHALL make the run remote:"), "Reference manifests: kind overlay remote run": "`deploy/overlays/kind` SHALL make the run remote: its own `orchestrator.yaml` replaces the base file in `orchestrator-config` (`behavior: replace`), holding every base key plus `runner.access: remote`, `git.workerOriginUrl` set to the `git-origin` Service URL, and `capacity: 3` (so every dependant of `SMOKE` is parked before the drills), and a patch sets `ORCH_WORKER_AGENT=scripted` on `orchestrator-worker`."
- s4, unchanged, "Reference manifests: fixture union merge": "The fixture SHALL carry a `.gitattributes` with `README.md merge=union`, seeded with the other fixture files, so concurrent smoke tasks that each append a line to `README.md` rebase onto one another without a conflict."

#### Smoke test

- s1: "`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`, port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses."
  - split (split between the items of its "in order:" list, before "port-forward"; the first part ends where the second begins), stays in "Smoke test": "`deploy/smoke.sh` SHALL be executable in git, start with `set -euo pipefail`, and in order: build the image, load it into the kind cluster `KIND_CLUSTER` (default `orch`), install the CloudNativePG operator from `CNPG_MANIFEST` and wait for it, apply `deploy/overlays/kind`, wait for `cluster/postgres`, `git-origin` and `orchestrator`."
  - split (second part, lead-in "`deploy/smoke.sh` SHALL in order:" repeated), "Smoke test: port-forward, graph upload and M1 poll": "`deploy/smoke.sh` SHALL in order: port-forward the Service to `127.0.0.1:$LOCAL_PORT` (default 18080, stepping to the next free port when `LOCAL_PORT` is unset and the default is held) and wait for `/healthz`, send the overlay's `graph.yaml` with `PUT /v1/graph`, and poll `/v1/status` until the assertions hold or `STATUS_TIMEOUT_S` elapses."
- s2, unchanged, "Smoke test: kubectl context pinned": "Every `kubectl` call that talks to a cluster SHALL pass `--context "$KUBE_CONTEXT"`."
- s3, unchanged, "Smoke test: kubectl context pinned": "`KUBE_CONTEXT` defaults to `kind-$KIND_CLUSTER`; any other value SHALL exit 2 before any step."
- s4: "The script SHALL leave the current kubectl context as it found it."
  - reference made explicit, "Smoke test: kubectl context restored": "`deploy/smoke.sh` SHALL leave the current kubectl context as it found it."
- s5: "Under `--fresh`, `kind create cluster` changes it, so the script SHALL restore the previous context, or unset it if none was set, with `kubectl config` calls that carry no `--context`."
  - reference made explicit, "Smoke test: kubectl context restored": "Under `--fresh`, `kind create cluster` changes the current kubectl context, so `deploy/smoke.sh` SHALL restore the previous context, or unset it if none was set, with `kubectl config` calls that carry no `--context`."
- s6, unchanged, "Smoke test: arguments": "The accepted arguments are `--dry-run`, `--fresh`, `--break pvc|claimable|restart` and `--real-agent <key file>` (see "Smoke test options"); `--dry-run` SHALL print each step, execute nothing, and exit 0; any other argument SHALL exit 2 with usage."
- s7, unchanged, "Smoke test: port-forward, graph upload and M1 poll": "M1 asserts pull mode and a claimable launch."
- s8, unchanged, stays in "Smoke test": "M2 asserts that the daemon pod has no volume backed by a claim, then runs the restart, outage and Postgres-restart drills."
- s9: "M3 scales the worker Deployment and asserts that the workers finish the run (see "Smoke M3 step")."
  - SHALL given at the joint ("scales" becomes "SHALL scale", "asserts" becomes "SHALL assert"), "Smoke test: M3 and M4 steps": "M3 SHALL scale the worker Deployment and SHALL assert that the workers finish the run (see "Smoke M3 step")."
- s10: "M4 checks the Claude worker image, a worker pod deleted mid-task and the launch trailers (see "Smoke M4 step"), and with `--real-agent` runs the real-agent step last (see "Smoke real-agent step")."
  - SHALL given at the joint ("checks" becomes "SHALL check", "runs" becomes "SHALL run"), "Smoke test: M3 and M4 steps": "M4 SHALL check the Claude worker image, a worker pod deleted mid-task and the launch trailers (see "Smoke M4 step"), and with `--real-agent` SHALL run the real-agent step last (see "Smoke real-agent step")."

#### Smoke worker step

- s1, unchanged, "Smoke worker step: smoke graph": "The kind overlay's graph SHALL hold one ready task, `SMOKE`, and three independent tasks that depend on it: `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`."
- s2, unchanged, stays in "Smoke worker step": "`deploy/smoke.sh` SHALL work `SMOKE` with one worker pod, `smoke-worker`: `orchestrator-worker` run with `ORCH_WORKER_AGENT=scripted`, `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`, which claims with `access: remote`, clones origin, commits on the launch branch, pushes it and submits with its sha."
- s3, unchanged, stays in "Smoke worker step": "The step SHALL fail unless the pod exits with phase `Succeeded` and its log shows `report accepted` for `SMOKE`; the pod SHALL be kept for the M3 log assertion."
- s4: "The script SHALL then wait until `SMOKE` is done and `SMOKE-PARKED` is claimable, and then until `SMOKE-M3-A` and `SMOKE-M3-B` are claimable too, so the claimable set does not change during the drills."
  - reference made explicit, "Smoke worker step: waits before the drills": "After the worker step, `deploy/smoke.sh` SHALL wait until `SMOKE` is done and `SMOKE-PARKED` is claimable, and then until `SMOKE-M3-A` and `SMOKE-M3-B` are claimable too, so the claimable set does not change during the drills."
- s5: "No claim the script makes SHALL be a local one: the outage drill's pending write, `--break claimable` and the final claim of `SMOKE-PARKED` all claim with `access: remote`."
  - reference made explicit, "Smoke worker step: remote claims only": "No claim `deploy/smoke.sh` makes SHALL be a local one: the outage drill's pending write, `--break claimable` and the final claim of `SMOKE-PARKED` all claim with `access: remote`."

#### Smoke restart drill

- s1, unchanged, stays in "Smoke restart drill": "Before deleting the daemon pod, `deploy/smoke.sh` SHALL record a snapshot."
- s2, unchanged, stays in "Smoke restart drill": "From the API it records the claimable launches as launch id and task id, the task states, `latestSeq`, the integration head (the `publishedSha` of `SMOKE`'s `transition` to `done`), and the daemon pod's uid."
- s3, unchanged, "Smoke restart drill: claimable launch ids from events": "The API lists claimable launches by task only, so their launch ids SHALL be read from the launch events: a launch is claimable when its latest `launch.claimable`, `launch.claimed`, `launch.released`, `launch.ended`, `launch.revoked` or `launch.failed` event is `launch.claimable`, and those launches' tasks SHALL equal `/v1/status` `claimable`."
- s4, unchanged, stays in "Smoke restart drill": "Through `psql` on the CloudNativePG instance pod it records the run's launch counts by status, the claimable launches as launch id, task id and the md5 of the token, and the task states."
- s5: "The script reads the run's access from the kind overlay's `orchestrator.yaml` (`runner.access`, `remote` in the kind overlay)."
  - SHALL given at the joint ("The script reads" becomes "`deploy/smoke.sh` SHALL read" (reference made explicit, and SHALL with its verb)), "Smoke restart drill: run access": "`deploy/smoke.sh` SHALL read the run's access from the kind overlay's `orchestrator.yaml` (`runner.access`, `remote` in the kind overlay)."
- s6: "After the rollout it SHALL wait until startup recovery has handled every recorded claimable launch, because `/readyz` passes before recovery runs, and only then SHALL it assert the scenarios below."
  - reference made explicit, "Smoke restart drill: wait for startup recovery": "After the rollout `deploy/smoke.sh` SHALL wait until startup recovery has handled every recorded claimable launch, because `/readyz` passes before recovery runs, and only then SHALL it assert the scenarios of "Smoke restart drill"."
- s7, unchanged, "Smoke restart drill: wait for startup recovery": "Under local access, handled means a `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event for that launch after the recorded sequence."
- s8: "Under remote access, startup recovery keeps a remote parked launch as it is (it has no worktree on the daemon to prepare again) and records none of those events, so `drill: startup recovery settled every recorded claimable launch` SHALL wait until `/readyz` passes, `/v1/status` `latestSeq` is at least the recorded sequence and the claimable set reads consistently from the events and `/v1/status`, and SHALL fail if any of those four events after the recorded sequence names a recorded claimable launch."
  - split (split at ", so"; first part: "keeps" becomes "SHALL keep", "records" becomes "SHALL record", "those events" made explicit), "Smoke restart drill: remote parked launch kept": "Under remote access, startup recovery SHALL keep a remote parked launch as it is (it has no worktree on the daemon to prepare again) and SHALL record none of the `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` events."
  - split (split at ", so"; second part: "Under remote access," repeated, "any of those four events" made explicit), "Smoke restart drill: remote recovery settled": "Under remote access, `drill: startup recovery settled every recorded claimable launch` SHALL wait until `/readyz` passes, `/v1/status` `latestSeq` is at least the recorded sequence and the claimable set reads consistently from the events and `/v1/status`, and SHALL fail if any `launch.reprepared`, `launch.ended`, `launch.revoked` or `launch.failed` event after the recorded sequence names a recorded claimable launch."
- s9: "The unchanged launch id and token assertions that follow carry the proof that each recorded launch is still parked."
  - reference made explicit, "Smoke restart drill: remote parked launch kept": "The unchanged launch id and token assertions that follow `drill: startup recovery settled every recorded claimable launch` carry the proof that each recorded launch is still parked."

#### Smoke assertions are named

- s1, unchanged, stays in "Smoke assertions are named": "Every assertion in `deploy/smoke.sh` SHALL print `smoke: pass: <name>` when it holds."
- s2, unchanged, stays in "Smoke assertions are named": "The first assertion that does not hold SHALL print `smoke: FAIL: <name>` to stderr, and the script SHALL exit 1."
- s3, unchanged, stays in "Smoke assertions are named": "A full pass SHALL end with `smoke: ok`."
- s4, unchanged, "Smoke assertions are named: dry run": "Under `--dry-run`, an assertion SHALL print its command and run nothing, except the three real-agent assertions, which without `--real-agent` print only `smoke: skip: <name> (needs --real-agent)`, in a dry run or not."
- s5, unchanged, stays in "Smoke assertions are named": "No assertion or step SHALL be skipped silently: one that does not run SHALL print `smoke: skip: <name> (<why>)` on stdout."
- s6, unchanged, stays in "Smoke assertions are named": "No environment variable SHALL turn an assertion off."

#### Smoke test options

- s1, unchanged, stays in "Smoke test options": "Besides `--dry-run`, `deploy/smoke.sh` SHALL accept three options."
- s2, unchanged, stays in "Smoke test options": "`--fresh` saves the current kubectl context, deletes and recreates the kind cluster `KIND_CLUSTER` before the first step, and restores the saved context."
- s3, unchanged, "Smoke test options: break values": "`--break pvc` creates a claim named `data-smoke-break`, mounts it into the daemon container by patching the Deployment, waits for that rollout's recovery, and only then records the restart-drill snapshot; on exit it removes the volume and mount from the Deployment and deletes the claim."
- s4, unchanged, "Smoke test options: break values": "`--break claimable` claims `SMOKE-PARKED`'s launch after the snapshot and before the restart."
- s5: "`--break restart` sends SIGTERM to the daemon process in place of deleting the Postgres pod, so the daemon's container restarts for a reason other than a lost session, and prints a skip line for the deletion."
  - SHALL given at the joint ("sends" becomes "SHALL send", "prints" becomes "SHALL print"), "Smoke test options: break restart": "`--break restart` SHALL send SIGTERM to the daemon process in place of deleting the Postgres pod, so the daemon's container restarts for a reason other than a lost session, and SHALL print a skip line for the deletion."
- s6, unchanged, "Smoke test options: break values": "Each `--break` value SHALL fail its drill at its own named assertion, every assertion before it passing."
- s7, unchanged, "Smoke test options: real agent": "`--real-agent <key file>` takes one value, the path of a file outside the repository that holds the Anthropic key, and runs the real-agent step (see "Smoke real-agent step"); a missing value or a path that breaks its key file rule SHALL exit 2 with one line on stderr, before any step and any tool."
- s8, unchanged, stays in "Smoke test options": "Any other argument, or any other `--break` value, SHALL exit 2 with usage."

#### Deployment run id

- s1, unchanged, stays in "Deployment run id": "The reference manifests SHALL set no fixed run id: neither `store.runId` in the ConfigMap nor `ORCH_RUN_ID` on the daemon."
- s2, unchanged, stays in "Deployment run id": "Each deployment SHALL get its id from its clone's origin (`REPO_URL`, with `git.pushIntegration` on)."
- s3, unchanged, "Deployment run id: deploy notes": "`deploy/README.md` SHALL state the order in which the id is chosen, its format, and when to set `store.runId` or `ORCH_RUN_ID`."
- s4, unchanged, "Deployment run id: deploy notes": "It SHALL also state that an origin hash follows the URL as written apart from user information, give spellings of one repository that yield different run ids (with and without `.git`, with a trailing slash, scp-like against `ssh://`), and name `store.runId` and `ORCH_RUN_ID` as the way to pin the id."
- s5, unchanged, stays in "Deployment run id": "`deploy/smoke.sh` SHALL read the run id from `/v1/status`."

#### Smoke Postgres-restart drill

- s1, unchanged, stays in "Smoke Postgres-restart drill": "After the outage drill, `deploy/smoke.sh` SHALL record `latestSeq`, the claimable launches and task states, the daemon pod's uid and its restart count."
- s2: "Under local access a container restart keeps the pod's `emptyDir`, so startup recovery would leave the parked worktrees alone and record nothing; the script SHALL therefore remove `.orchestrator/brief.json` from each recorded claimable launch's worktree in the pod, so that recovery prepares each again and records `launch.reprepared`."
  - reference made explicit, "Smoke Postgres-restart drill: parked briefs": "Under local access a container restart keeps the pod's `emptyDir`, so startup recovery would leave the parked worktrees alone and record nothing; `deploy/smoke.sh` SHALL therefore remove `.orchestrator/brief.json` from each recorded claimable launch's worktree in the pod, so that recovery prepares each again and records `launch.reprepared`."
- s3, unchanged, "Smoke Postgres-restart drill: parked briefs": "Under remote access a parked launch has no worktree on the daemon, so the script removes nothing and says so."
- s4, unchanged, stays in "Smoke Postgres-restart drill": "It SHALL start following the daemon container's log into a file, and then delete the Postgres instance pod."
- s5, unchanged, stays in "Smoke Postgres-restart drill": "The daemon SHALL be seen to exit before readiness is awaited, because the pod is still Ready just after the deletion."
- s6, unchanged, "Smoke Postgres-restart drill: recovery assertions": "The comparisons SHALL wait on conditions with timeouts, never on a fixed sleep."
- s7, unchanged, "Smoke Postgres-restart drill: recovery assertions": "`pg-restart: startup recovery prepared every claimable launch again` and `pg-restart: one launch.reprepared per claimable launch` keep their names; under remote access they assert what recovery does for a remote parked launch, as `drill: startup recovery settled every recorded claimable launch` and `drill: one launch.reprepared per claimable launch` do (see "Smoke restart drill")."

#### Worker Deployment

- s1: "`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `replicas: 0`, whose pods carry the label `app.kubernetes.io/name: orchestrator-worker` (so no selector of the daemon matches them), run as uid and gid 1000 with `fsGroup` 1000, set `terminationGracePeriodSeconds: 120` (the time the loop's hand-back on SIGTERM needs with every wait at its limit, see specs/worker-pool "Pod termination"), and hold one container on `orchestrator:dev` with command `orchestrator-worker` and no `lifecycle` (no preStop hook: the container's command is the loop, which gets the kubelet's SIGTERM itself); `POD_NAME` from `metadata.name` through the Downward API; `ORCH_API` set to the daemon Service URL `http://orchestrator.orch.svc:8080`; and an `emptyDir` mounted at the clone cache, `/var/cache/orchestrator` (`ORCH_WORKER_CACHE`)."
  - split (split at its semicolons, then the first part between its comma items before "set"; ", run as" becomes " and run as"), stays in "Worker Deployment": "`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `replicas: 0`, whose pods carry the label `app.kubernetes.io/name: orchestrator-worker` (so no selector of the daemon matches them) and run as uid and gid 1000 with `fsGroup` 1000."
  - split (first part split between its comma items; lead-in "... `orchestrator-worker` whose pods" repeated), "Worker Deployment: termination": "`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` whose pods set `terminationGracePeriodSeconds: 120` (the time the loop's hand-back on SIGTERM needs with every wait at its limit, see specs/worker-pool "Pod termination"), and hold one container on `orchestrator:dev` with command `orchestrator-worker` and no `lifecycle` (no preStop hook: the container's command is the loop, which gets the kubelet's SIGTERM itself)."
  - split (semicolon items, lead-in "... `orchestrator-worker` with" repeated), "Worker Deployment: environment and clone cache": "`deploy/base/worker.yaml` SHALL define a Deployment `orchestrator-worker` with `POD_NAME` from `metadata.name` through the Downward API; `ORCH_API` set to the daemon Service URL `http://orchestrator.orch.svc:8080`; and an `emptyDir` mounted at the clone cache, `/var/cache/orchestrator` (`ORCH_WORKER_CACHE`)."
- s2, unchanged, stays in "Worker Deployment": "It SHALL have no volume claim."
- s3, unchanged, stays in "Worker Deployment": "The base names no agent."
- s4, unchanged, "Worker Deployment: deploy notes": "`deploy/README.md` SHALL describe the worker Deployment, `runner.access: remote`, `git.workerOriginUrl`, the termination on SIGTERM, and the M3 smoke step."

#### Smoke M3 step

- s1, unchanged, stays in "Smoke M3 step": "After the last drill assertion, `deploy/smoke.sh` SHALL scale `orchestrator-worker` to 2, wait for its rollout, and follow each worker pod's log into a file from its first line, because a worker exits once the run is finished and its restarted container would hide the log."
- s2, unchanged, stays in "Smoke M3 step": "It SHALL then assert, with these names:"
- s3: "- `M3: the run is finished`: within `FINISH_TIMEOUT_S` (default 600) seconds, `/v1/status` `finished` is `true`;"
  - split (the list keeps only its first item; its closing ";" becomes "."), stays in "Smoke M3 step": "- `M3: the run is finished`: within `FINISH_TIMEOUT_S` (default 600) seconds, `/v1/status` `finished` is `true`."
- s4: "- `M3: every smoke task is on origin's integration branch`: the first-parent history of origin's `main` carries an `Orchestrator-Task` trailer for each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`;"
  - given its list's lead-in (list lead-in "`deploy/smoke.sh` SHALL then assert, with these names:" ("It" made explicit), list marker dropped, closing ";" becomes "."), "Smoke M3 step: integration branch assertion": "`deploy/smoke.sh` SHALL then assert, with these names: `M3: every smoke task is on origin's integration branch`: the first-parent history of origin's `main` carries an `Orchestrator-Task` trailer for each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`."
- s5: "- `M3: worker logs show one accepted report per task`: the log of `smoke-worker` and the followed worker logs together hold exactly one `worker <id> report accepted <launchId> <taskId>` line for each of those four tasks, and none for another task."
  - given its list's lead-in (list lead-in "`deploy/smoke.sh` SHALL then assert, with these names:" ("It" made explicit), list marker dropped, "each of those four tasks" made explicit), "Smoke M3 step: worker log assertion": "`deploy/smoke.sh` SHALL then assert, with these names: `M3: worker logs show one accepted report per task`: the log of `smoke-worker` and the followed worker logs together hold exactly one `worker <id> report accepted <launchId> <taskId>` line for each of `SMOKE`, `SMOKE-PARKED`, `SMOKE-M3-A` and `SMOKE-M3-B`, and none for another task."

### Where each new scenario comes from

Each scenario rests on the files below, as they are at the base commit 941ee02:

- "Claim and brief name the advertised URL": `test/slice/bind.test.ts` ("binds apiBind and advertises apiBaseUrl in kv, daemon.json, status, claims, and briefs").
- "A runtime override naming the bind key is refused": `src/runs/resolve.ts` (`OVERRIDABLE_KEYS` and the strict `overridesSchema`, through `parseOverridePatch`, which `applyOverridePatch` and `parseSetFlags` call).
- "Lag past one flush retry, then a lost lock": `test/state/store-selection.test.ts` ("journal readiness"), `src/state/journal.ts` (`readiness`) and `src/operator/routes.ts` (`readinessFailures`).
- "Probes on the bound address without a token": `test/slice/bind.test.ts` (the probes on the non-loopback address) and `test/slice/probes.test.ts` ("healthz answers ok and readyz answers ok on a healthy daemon, without a token").
- "Only git, SSH and certificates are installed": `test/host/docker.test.ts` ("final stage installs git and openssh-client and nothing that is a toolchain").
- "Local state stays out of the build context": `test/host/docker.test.ts` (".dockerignore keeps local state and fixtures out of the context").
- "The notes name the image and how to build it": `test/host/docker.test.ts` ("deploy/README.md names the image, the build command, and both entrypoints").
- "The ConfigMap's one file": `test/host/deploy.test.ts` ("the ConfigMap holds orchestrator.yaml for a pull-mode, cluster-bound, never-idle daemon on Postgres, and no graph").
- "Recreate on an emptyDir with a clone" and "The store URL is a mounted file": `test/host/deploy.test.ts` ("the daemon is Recreate, clones REPO_URL into an emptyDir, reads the store URL from the mounted CloudNativePG Secret file, and runs orchestrator --repo on the clone").
- "git-origin serves pushes and is the clone's origin": `test/host/deploy.test.ts` ("the kind overlay adds git-origin and points REPO_URL at it").
- "The overlay's file is the base file plus the remote keys": `test/host/deploy.test.ts` ("the kind overlay replaces orchestrator.yaml with a remote run: ...").
- "The attributes file reaches the seeded repository": `deploy/overlays/kind/fixture/.gitattributes`, `deploy/overlays/kind/kustomization.yaml` (`configMapGenerator`) and `deploy/overlays/kind/git-origin.yaml` (`cp -L /fixture/* /fixture/.gitattributes /tmp/seed/`).
- "The forward, the graph and the first poll follow the waits": `deploy/smoke.sh` (steps 5 to 8 and the M1 `check`) and `test/host/smoke.test.ts` ("--dry-run prints the steps in order, executes nothing, and exits 0").
- "The default context follows the cluster name": `deploy/smoke.sh` (`KUBE_CONTEXT` default and `kc`) and `test/host/smoke.test.ts` ("loads into and targets the cluster named by KIND_CLUSTER").
- "The context is saved before the cluster is recreated": `test/host/smoke.test.ts` ("--fresh saves the current context, recreates the cluster, and restores the context").
- "A dry run executes nothing": `test/host/smoke.test.ts` ("--dry-run prints the steps in order, executes nothing, and exits 0") and `deploy/smoke.sh` (`step`).
- "Dry run order of the M3 and M4 steps": `test/host/smoke.test.ts` ("--dry-run lists M4 block A between the final claim and the M3 scale-up, then block B and the real-agent skips after M3").
- "One ready task and three dependants": `deploy/overlays/kind/graph.yaml`.
- "Every dependant is parked before the snapshot": `deploy/smoke.sh` (the checks `drill: $WORK_TASK published` and `drill: $PARKED_TASK claimable` and the step after them, before the snapshot).
- "Each claim the script sends names remote access": `deploy/smoke.sh` (`outage_write`, the `--break claimable` step and `claim_returns_recorded_launch`).
- "Events and status disagree": `deploy/smoke.sh` (`api_claimable`).
- "A launch recovery has not handled yet holds the comparison back": `deploy/smoke.sh` (`recovery_settled` under local access, and the order of the restart drill's checks).
- "Access read from the overlay": `deploy/smoke.sh` (`RUN_ACCESS`) and `deploy/overlays/kind/orchestrator.yaml`.
- "Recovery records an event for a remote parked launch": `deploy/smoke.sh` (`recovery_settled` under remote access).
- "The proof that a remote launch is still parked": `deploy/smoke.sh` (the checks `drill: claimable set unchanged (API)` and `(psql)`, with `api_claimable` and `pg_claimable_tokens`).
- "Real-agent assertions skipped without the option": `deploy/smoke.sh` (`REAL_NAMES` and the skip loop) and `test/host/smoke.test.ts` (the M4 dry-run test).
- "Where each break happens": `test/host/smoke.test.ts` ("--break pvc mounts the claim before the snapshot; --break claimable claims after it").
- "SIGTERM in place of the Postgres pod deletion": `deploy/smoke.sh` (the `--break restart` branch and `stop_daemon_process`).
- "A symbolic link is refused": `test/host/smoke.test.ts` ("refuses --real-agent without a value, with a missing file, with a file in the repository, or a symbolic link, before any tool").
- "The notes list the order and the spellings": `deploy/README.md` ("The run id").
- "Briefs removed under local access, nothing under remote": `deploy/smoke.sh` (`remove_parked_briefs`).
- "The recovery assertions retry within a limit": `deploy/smoke.sh` (the `pg-restart:` checks, `recovery_settled` and `reprepared_once_each`).
- "Grace period and container command in both renders": `test/host/worker-termination.test.ts`.
- "Worker id, API and cache": `test/host/deploy.test.ts` ("the base renders orchestrator-worker: replicas 0, POD_NAME from the Downward API, an emptyDir clone cache, ORCH_API at the daemon Service").
- "The notes describe the worker pool": `deploy/README.md` ("The workers" and "Smoke test").
- "A task without a trailer on origin": `deploy/smoke.sh` (`origin_carries_all_tasks` and `check`).
- "Logs read once the followers end": `deploy/smoke.sh` (`one_accepted_report_per_task`).

## Capabilities

### New Capabilities

### Modified Capabilities

- `cluster-runtime`: the 13 requirements listed above have their descriptions cut to one behavior each. The moved behaviors become 38 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-cluster-runtime/`. No code changes.
