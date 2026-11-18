# worker-pool Specification

## Purpose
TBD - created by archiving change worker-loop. Update Purpose after archive.
## Requirements
### Requirement: Worker loop
The `orchestrator-worker` bin (`dist/src/worker/loop.js`) SHALL run the remote worker loop against the daemon at `ORCH_API`, which is required. Each round SHALL `POST /v1/claims` with `{ workerId, access: 'remote' }`. A 200 SHALL be worked as one launch (see "Clone cache", "Agent command", "Scripted agent" and "Fallback relay") and the loop SHALL claim again. On a 404 (nothing claimable, or paused) or a 409 the loop SHALL read `GET /v1/status` and exit 0 when it says `finished`; otherwise it SHALL exit 0 when nothing has been claimed for `ORCH_WORKER_IDLE_EXIT_MS` (default 0, which never exits for idleness), and else wait before the next claim. The wait SHALL start at `ORCH_WORKER_BACKOFF_MS` (default 1000), double after each wait up to `ORCH_WORKER_BACKOFF_MAX_MS` (default 30000), and reset to the first value after a claim. A 400 on a claim SHALL end the loop with exit 1. A call that gets no answer SHALL be retried for `ORCH_RETRY_WINDOW_MS` (default 60000), with delays from 100 ms doubling to 1 s; past it the loop SHALL exit 1. A 401 on a call made for a launch SHALL end that launch's work, and the loop SHALL claim again. The loop SHALL write one line per step to stdout, `worker <id> <event> <launchId> <taskId>` with `-` for a missing id, and SHALL write `report accepted` once for each launch whose submission the daemon accepted; details and the agent's output SHALL go to stderr. After the agent exits and any fallback report is relayed, the loop SHALL read the status: a task `submitted` or `done` (or a submit answered with `accepted: true`) is `report accepted`; a launch the worker still holds is released without keep with reason `the agent exited without a report`; otherwise the launch has ended. A launch whose clone cannot be prepared SHALL be released without keep. Heartbeats from the loop, pod termination and usage are not part of this requirement.

#### Scenario: Two loops work a chain
- **WHEN** a remote run with a bare origin has the chain T1 -> T2 -> T3 and two loops with ids `w-1` and `w-2` run the scripted agent with separate caches
- **THEN** all three tasks become `done`, origin's integration branch carries one `Orchestrator-Task` trailer per task, `/v1/status` reports `finished`, both loops exit 0, and each loop's stdout has one `report accepted` line per task it claimed, three in all

#### Scenario: Backoff with nothing claimable
- **WHEN** every claim answers 404 and the status is not finished, with `ORCH_WORKER_IDLE_EXIT_MS` 120000
- **THEN** the loop waits 1, 2, 4, 8, 16, 30, 30 and 30 s and then exits 0 with an `idle-exit` line

#### Scenario: Finished run
- **WHEN** a claim answers 404 and `/v1/status` says `finished: true`
- **THEN** the loop prints a `finished` line and exits 0

### Requirement: Worker identity
The worker id sent with every claim SHALL be `POD_NAME` when set and not empty, else `ORCH_WORKER_ID`, else the host name. The loop SHALL refuse to start (exit 2, naming the variable) without `ORCH_API`, with an `ORCH_WORKER_AGENT` other than `scripted` or `command`, with the agent `command` (the default) and no `ORCH_WORKER_COMMAND`, or with a duration variable that is not a non-negative integer.

#### Scenario: Pod name wins
- **WHEN** `POD_NAME` is `pod-a` and `ORCH_WORKER_ID` is `id-b`
- **THEN** the worker id is `pod-a`; without `POD_NAME` it is `id-b`; without either it is the host name

### Requirement: Clone cache
The loop SHALL keep one clone per `repoUrl` under `ORCH_WORKER_CACHE` (default `/var/cache/orchestrator`), named from the URL and a hash of it, and reuse it across launches; a directory there that is not a clone SHALL be replaced. The clone's `.git/info/exclude` SHALL list `/.orchestrator/`. Before each launch the loop SHALL abort an operation a previous agent left in progress, `git fetch origin`, fetch the start commit by its sha when the fetch did not bring it, `git checkout -f -B <branch> <start>` with start `carry.interrupted.headSha` when the claim carries it and `baseSha` otherwise, `git clean -ffdx` except `.orchestrator/`, and remove a stale `.orchestrator/report.json`. It SHALL then write `.orchestrator/brief.md` (the claim's `briefMarkdown`), `.orchestrator/brief.json` (the claim's `brief`, its `worktree` set to the clone) and `.orchestrator/mcp.json` (the MCP shim with `ORCH_API`, the launch id and token, mode 0600).

#### Scenario: Interrupted head as the start
- **WHEN** a claim carries `carry.interrupted.headSha` H, a commit on origin
- **THEN** the launch branch is created at H, and the scripted agent's commit on it has H as its parent

#### Scenario: Clone reused, tree clean
- **WHEN** one loop works two launches in a row and the first agent left an untracked file, an untracked directory and an uncommitted change
- **THEN** both agents run in the same clone directory, and the second sees nothing in `git status --porcelain --ignored` but the ignored `.orchestrator/`

### Requirement: Agent command
With `ORCH_WORKER_AGENT=command` the loop SHALL compose `ORCH_WORKER_COMMAND` through the same functions every runner uses, `substitute` and `fixedSlots` in `src/runner/command.ts`: `{brief}`, `{briefJson}` and `{mcpConfig}` under the clone's `.orchestrator/`, `{worktree}` the clone, `{launchId}`, `{taskId}`, `{model}` and `{effort}` from the claim, and `{allowedTools}` the brief's `allowedTools` quoted as for a spawned launch; a slot with no value stays as written. The command SHALL run through `/bin/sh -c` in the clone with the loop's environment plus `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID` and `ORCH_WORKTREE` (the clone), and without the store's connection variables; the loop SHALL wait for it to exit.

#### Scenario: Placeholders filled by the shared function
- **WHEN** the template holds every placeholder
- **THEN** the command is the result of `substitute` called with the template and `fixedSlots` of the launch with the clone as the worktree, and the default Claude Code template composes with no slot left

### Requirement: Scripted agent
With `ORCH_WORKER_AGENT=scripted` the loop SHALL run the scripted agent in `src/worker/` (shipped with the package, not a test file): it SHALL append one line naming the task id and the worker id to `README.md`, commit it on the launch branch, push the branch to origin (forced, since the launch branch belongs to the launch alone), and submit with `seq` 1, `sealedSha` the pushed commit and one `acceptance` entry per criterion of the brief, named by its position. A 503 on the submit SHALL be retried with the same seq; a 401 ends the agent.

#### Scenario: Deterministic submission
- **WHEN** the scripted agent works a remote launch whose task has one criterion
- **THEN** origin's launch branch holds one new commit adding the README line, and the submit carries `sealedSha` that commit and an `acceptance` entry with criterion `1`

### Requirement: Fallback relay
After the agent exits, a `.orchestrator/report.json` left in the clone (`{ launchId, seq, kind, body }`) SHALL be posted with the launch token to the launch's report route with `kind` and `seq` (a `block` to the block route), and SHALL then be deleted, whatever the answer. A submit without `sealedSha` SHALL get the clone's HEAD, after the loop pushed HEAD to the launch branch on origin. A file that is not JSON or has no known kind SHALL be deleted and logged, and nothing posted.

#### Scenario: Relayed submit
- **WHEN** a command-mode agent commits without pushing and writes a submit to `.orchestrator/report.json` instead of calling the API
- **THEN** the loop pushes the branch, posts the report with `sealedSha` the pushed tip, deletes the file, prints `relayed` and `report accepted`, and the task becomes `submitted`

### Requirement: Loop heartbeat
From the claim until the agent exits, the worker loop SHALL send `POST /v1/launches/:id/heartbeat` with the launch token every `lease.renewEveryMs` of the claim (a third of `leaseTtlMs`; a third of `lease.ttlMs` when `renewEveryMs` is absent), whether or not the agent calls the API itself, so that a healthy worker never loses its lease during a long silent step. Once the clone is prepared, each heartbeat SHALL carry `fingerprint`, the clone's fingerprint computed by the same function the daemon's `GitWorkspace.fingerprint` uses (specs/health-monitoring "Progress signals"), so the same tree gives the same string; it SHALL carry no `progress` text, so it is never a `heartbeatText` signal. The next heartbeat SHALL be timed from the answer to the previous one, so two never overlap. A heartbeat answered 401 SHALL end the heartbeats for that launch. The heartbeats SHALL stop when the agent exits, before any fallback report is relayed, and when the clone cannot be prepared. A loop heartbeat renews the lease, as every agent call does, and counts as progress only when its fingerprint changed.

#### Scenario: Silent agent keeps its lease
- **WHEN** a remote run with `leaseTtlMs` 60000 runs the scripted agent, which sleeps for three lease TTLs without calling the API before it commits and submits, and the daemon ticks on the same fake clock throughout
- **THEN** the loop sends nine heartbeats, one every 20 s from the claim, each with the clone's fingerprint and no text; the lease never expires; and the task ends `submitted`

#### Scenario: Without heartbeats the lease lapses
- **WHEN** the same run's loop sends no heartbeat
- **THEN** the launch ends with reason `leaseExpired`

#### Scenario: Revoked launch
- **WHEN** a loop heartbeat is answered 401
- **THEN** the loop sends no further heartbeat for that launch

#### Scenario: One fingerprint function
- **WHEN** the loop fingerprints its clone and `GitWorkspace.fingerprint` reads the same directory, clean, edited, with an untracked file and after a commit
- **THEN** both give the same string each time

### Requirement: Task filter and launch limit
The worker loop SHALL read two optional variables. `ORCH_WORKER_TASK`, when set to a non-empty value, SHALL be sent as `taskId` in every claim, so the worker claims only that task's launch; a claim answered 404 or 409 is waited on as any other. `ORCH_WORKER_MAX_LAUNCHES`, a non-negative integer, SHALL make the loop exit 0 once it has worked that many claimed launches to their end (a report accepted, a release, or an ended launch), without claiming again; unset or 0 SHALL mean no limit. A malformed `ORCH_WORKER_MAX_LAUNCHES` SHALL be refused at start, naming the variable, with exit 2. After the limit the loop SHALL print `worker <id> max-launches - -`.

#### Scenario: One task, one launch
- **WHEN** the loop runs with `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`
- **THEN** its claim is `{ workerId, access: 'remote', taskId: 'SMOKE' }`, and after that launch it prints `max-launches` and exits 0 without a second claim

#### Scenario: No filter
- **WHEN** neither variable is set
- **THEN** the claim names no `taskId` and the loop claims again after each launch

#### Scenario: Malformed limit
- **WHEN** `ORCH_WORKER_MAX_LAUNCHES` is `-1` or `one`
- **THEN** the settings are refused with an error naming `ORCH_WORKER_MAX_LAUNCHES`

