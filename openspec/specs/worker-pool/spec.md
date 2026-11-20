# worker-pool Specification

## Purpose
The remote worker loop `orchestrator-worker`: how a worker in another process or pod claims remote launches over the daemon's API, works each in its own clone, reports, and hands launches back.

## Requirements

### Requirement: Worker loop
The `orchestrator-worker` bin (`dist/src/worker/loop.js`) SHALL run the remote worker loop against the daemon at `ORCH_API`, which is required. Each round SHALL `POST /v1/claims` with `{ workerId, access: 'remote' }`. A 200 SHALL be worked as one launch (see "Clone cache", "Agent command", "Scripted agent" and "Fallback relay") and the loop SHALL claim again. Heartbeats from the loop, pod termination and usage are not part of this requirement.

#### Scenario: Two loops work a chain
- **WHEN** a remote run with a bare origin has the chain T1 -> T2 -> T3 and two loops with ids `w-1` and `w-2` run the scripted agent with separate caches
- **THEN** all three tasks become `done`, origin's integration branch carries one `Orchestrator-Task` trailer per task, `/v1/status` reports `finished`, both loops exit 0, and each loop's stdout has one `report accepted` line per task it claimed, three in all

#### Scenario: Backoff with nothing claimable
- **WHEN** every claim answers 404, the status is not finished and the verdict for the worker's kinds is never `standby`, with `ORCH_WORKER_IDLE_EXIT_MS` 120000
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
The clone's `.git/info/exclude` SHALL list `/.orchestrator/`. Before each launch the loop SHALL abort an operation a previous agent left in progress, `git fetch origin`, fetch the start commit by its sha when the fetch did not bring it, `git checkout -f -B <branch> <start>` with start `carry.interrupted.headSha` when the claim carries it and `baseSha` otherwise, `git clean -ffdx` except `.orchestrator/`, and remove a stale `.orchestrator/report.json`.

#### Scenario: Interrupted head as the start
- **WHEN** a claim carries `carry.interrupted.headSha` H, a commit on origin
- **THEN** the launch branch is created at H, and the scripted agent's commit on it has H as its parent

#### Scenario: Clone reused, tree clean
- **WHEN** one loop works two launches in a row and the first agent left an untracked file, an untracked directory and an uncommitted change
- **THEN** both agents run in the same clone directory, and the second sees nothing in `git status --porcelain --ignored` but the ignored `.orchestrator/`

#### Scenario: Remote variables in mcp.json
- **WHEN** a loop runs a command agent that reads `.orchestrator/mcp.json`, starts the server it names, commits without pushing, and calls its `report` tool with kind `submit`
- **THEN** the shim's `env` there has `ORCH_ACCESS` `remote`, `ORCH_WORKTREE` the agent's working directory and `ORCH_BRANCH` the launch branch, the task is `submitted`, and the loop prints one `report accepted` line and no `relayed` line

### Requirement: Agent command
With `ORCH_WORKER_AGENT=command` the loop SHALL compose `ORCH_WORKER_COMMAND` through the same functions every runner uses, `substitute` and `fixedSlots` in `src/runner/command.ts`: `{brief}`, `{briefJson}` and `{mcpConfig}` under the clone's `.orchestrator/`, `{worktree}` the clone, `{launchId}`, `{taskId}`, `{model}` and `{effort}` from the claim, and `{allowedTools}` the brief's `allowedTools` quoted as for a spawned launch; a slot with no value stays as written.

#### Scenario: Placeholders filled by the shared function
- **WHEN** the template holds every placeholder
- **THEN** the command is the result of `substitute` called with the template and `fixedSlots` of the launch with the clone as the worktree, and the default Claude Code template composes with no slot left

### Requirement: Scripted agent
With `ORCH_WORKER_AGENT=scripted` the loop SHALL run the scripted agent in `src/worker/` (shipped with the package, not a test file): it SHALL append one line naming the task id and the worker id to `README.md`, commit it on the launch branch, push the branch to origin (forced, since the launch branch belongs to the launch alone), and submit with `seq` 1, `sealedSha` the pushed commit and one `acceptance` entry per criterion of the brief, named by its position.

#### Scenario: Deterministic submission
- **WHEN** the scripted agent works a remote launch whose task has one criterion
- **THEN** origin's launch branch holds one new commit adding the README line, and the submit carries `sealedSha` that commit and an `acceptance` entry with criterion `1`

### Requirement: Fallback relay
After the agent exits, a `.orchestrator/report.json` left in the clone (`{ launchId, seq, kind, body }`) SHALL be posted with the launch token to the launch's report route with `kind` and `seq` (a `block` to the block route), and SHALL then be deleted, whatever the answer. A submit without `sealedSha` SHALL get the clone's HEAD, after the loop pushed HEAD to the launch branch on origin. A file that is not JSON or has no known kind SHALL be deleted and logged, and nothing posted.

#### Scenario: Relayed submit
- **WHEN** a command-mode agent commits without pushing and writes a submit to `.orchestrator/report.json` instead of calling the API
- **THEN** the loop pushes the branch, posts the report with `sealedSha` the pushed tip, deletes the file, prints `relayed` and `report accepted`, and the task becomes `submitted`

### Requirement: Loop heartbeat
From the claim until the agent exits, the worker loop SHALL send `POST /v1/launches/:id/heartbeat` with the launch token every `lease.renewEveryMs` of the claim (a third of `leaseTtlMs`; a third of `lease.ttlMs` when `renewEveryMs` is absent), whether or not the agent calls the API itself, so that a healthy worker never loses its lease during a long silent step. A heartbeat answered 401 SHALL end the heartbeats for that launch.

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
The worker loop SHALL read two optional variables. `ORCH_WORKER_TASK`, when set to a non-empty value, SHALL be sent as `taskId` in every claim, so the worker claims only that task's launch; a claim answered 404 or 409 is waited on as any other. A malformed `ORCH_WORKER_MAX_LAUNCHES` SHALL be refused at start, naming the variable, with exit 2.

#### Scenario: One task, one launch
- **WHEN** the loop runs with `ORCH_WORKER_TASK=SMOKE` and `ORCH_WORKER_MAX_LAUNCHES=1`
- **THEN** its claim is `{ workerId, access: 'remote', taskId: 'SMOKE' }`, and after that launch it prints `max-launches` and exits 0 without a second claim

#### Scenario: No filter
- **WHEN** neither variable is set
- **THEN** the claim names no `taskId` and the loop claims again after each launch

#### Scenario: Malformed limit
- **WHEN** `ORCH_WORKER_MAX_LAUNCHES` is `-1` or `one`
- **THEN** the settings are refused with an error naming `ORCH_WORKER_MAX_LAUNCHES`

### Requirement: Pod termination
On SIGTERM or SIGINT the worker loop SHALL claim no more and SHALL hand back a launch it holds: it SHALL stop the agent's process group, relay a fallback report, read the status, and, while it still holds the launch, commit the work in progress, push `HEAD` to the launch branch and release with keep and reason `podTerminating`. It SHALL exit 0 when it held nothing, the report was accepted, the launch had ended or the release was answered 200, and 1 otherwise.

#### Scenario: Signals
- **WHEN** the loop gets SIGTERM or SIGINT
- **THEN** it prints `worker <id> terminating <launchId> <taskId>` (`-` for a missing id) and claims no more; a second signal during the termination changes nothing and records no second release

#### Scenario: Idle
- **WHEN** the loop gets the signal with no launch held and no claim in flight
- **THEN** it ends its wait and exits 0 at once, and releases nothing

#### Scenario: Claim in flight
- **WHEN** the signal arrives while a claim is in flight
- **THEN** the claim's fetch is aborted and the claim is sent again for at most 5000 ms (`TERMINATION_CALL_MS`); answered 200, its launch is released without keep with reason `podTerminating`, no agent starts and the loop exits 0 when the release is answered 200; with any other answer, or no answer within those 5000 ms, it exits 0

#### Scenario: Claim never answered
- **WHEN** in `test/worker/loop.test.ts`, with `retryWindowMs` 60000, a claim is in flight at SIGTERM and the daemon never answers it
- **THEN** the loop exits 0 within `TERMINATION_CALL_MS` plus 1000 ms of the signal

#### Scenario: Agent not started
- **WHEN** the signal arrives while the clone is prepared or before the agent starts
- **THEN** the launch is released without keep with reason `podTerminating` at once, without waiting for the clone

#### Scenario: Stopping the agent
- **WHEN** the signal arrives while the command agent runs, in its process group of its own
- **THEN** the loop sends SIGTERM to the group, waits up to `ORCH_WORKER_AGENT_STOP_MS` (default 10000, set in `WorkerSettings` only when the variable is set) for it to exit and close its pipes, and then sends SIGKILL to the group; 0 sends SIGKILL at once; after a SIGKILL it waits for the command's exit, not for its pipes; the scripted agent is awaited

#### Scenario: Steps after the agent
- **WHEN** the agent has exited after the signal
- **THEN** the loop stops its heartbeats (waiting at most 5 s for one in flight), relays a fallback report, and reads the status; a task `submitted` or `done` is `report accepted` and nothing is released; a launch that has ended is left alone; a launch still held, or a status read without an answer or answered other than 200, is handed back

#### Scenario: Work in progress
- **WHEN** a held launch is handed back and the clone has uncommitted or untracked files outside `.orchestrator/`
- **THEN** they are committed on the launch branch as one commit (`git add -A`, hooks skipped, identity `orchestrator-worker <worker@orchestrator.local>`), `HEAD` is pushed to the launch branch on origin, forced, within 30 s, and release is called with `{ workerId, reason: 'podTerminating', keep: true, headSha, wipCommit }`, `headSha` the pushed `HEAD`

#### Scenario: Nothing uncommitted
- **WHEN** a held launch is handed back with a clean clone
- **THEN** nothing is committed, the push and the release still run, and the release body has no `wipCommit`; at the launch's base with no agent API call the daemon answers `kept: false`

#### Scenario: Failed commit
- **WHEN** the work-in-progress commit fails (an `index.lock` left behind, say)
- **THEN** the loop logs it, pushes `HEAD` as it is and releases with that `headSha` and no `wipCommit`

#### Scenario: Failed push
- **WHEN** the push fails
- **THEN** the loop prints `push-failed` (git's message on stderr), calls no release, and exits 1; the lease expiry then decides from what origin holds

#### Scenario: Failed release
- **WHEN** the release is answered other than 200 or gets no answer
- **THEN** the loop prints `release-failed` (the status with the answer's `error` or `reason` on stderr), does not try again, and exits 1; a release answered 200 prints `released` and exits 0 whatever `kept` says

#### Scenario: Bounded calls after the signal
- **WHEN** the loop starts an API call after the signal (the relay's post, the status read, the release)
- **THEN** a connection failure is retried for at most the smaller of `ORCH_RETRY_WINDOW_MS` and 5000 ms, each fetch is bounded as verifier-pool `Verifier termination: bounded calls` says, and a call in flight at the signal is aborted and has at most 5000 ms left; a push the relay makes after the signal is limited to 30 s and stays unforced

#### Scenario: Handed back in a slice
- **WHEN** in `test/slice/worker-termination.test.ts` an agent changes a tracked file, adds an untracked file and waits, and the loop gets SIGTERM
- **THEN** the loop exits 0, `launch.released` has `reason: podTerminating`, `keep: true`, `kept: true` and `headSha`, origin's branch tip is that commit holding both files and nothing under `.orchestrator/`, the task is `unstarted` with `attempts` 0 and `interruptions` 1, and the next claim answers `carry.interrupted.headSha` equal to it

### Requirement: Usage post
The worker loop SHALL keep the last 256 KiB of the command agent's standard output, parse it with `parseUsage` once the agent process has exited, and, when the result has token counts, post `{ workerId, usage: { tokens, model, costUsd } }` once to `POST /v1/launches/:id/usage` as the last step of the launch. `model` is the claim's model when it has one; `costUsd` is `total_cost_usd` when above zero. Turns and duration are not posted.

#### Scenario: Recorded cost
- **WHEN** the agent's standard output ends with a Claude Code result object with `total_cost_usd` 0.25 and a `usage` of 100 input, 40 cache-read and 7 output tokens, and its report is accepted
- **THEN** after `report accepted` the loop posts the usage, the launch row has `usageSource: "worker"`, `costUsd` 0.25, `costSource: "reported"` and `tokens` `{ input: 140, cachedInput: 40, output: 7 }`, and the loop prints `worker <id> usage <launchId> <taskId>` once

#### Scenario: Tokens priced by the daemon
- **WHEN** the object has token counts and no `total_cost_usd` (or 0), and `budgets.prices` has the claim's model
- **THEN** the body has no `costUsd`, and the daemon prices the tokens: the row has `costSource: "priced"` and a cost above zero, which `budgets.maxRunCostUsd` counts

#### Scenario: No object
- **WHEN** the agent printed no such object, printed a line after it, printed one without `usage`, or the agent is the scripted one
- **THEN** nothing is posted and the launch has no usage

#### Scenario: Post not recorded
- **WHEN** the post is answered other than 200 with `recorded: true` (409 for a launch another worker holds, 400) or cannot be sent
- **THEN** the answer is written to stderr, no `usage` line is printed, and neither the launch's verdict nor the loop's exit code changes

#### Scenario: Terminated launch
- **WHEN** the loop gets SIGTERM while the agent runs, the agent prints its object as it stops, and the hand-back's release is answered
- **THEN** the usage is posted after that release, whatever its status, through the short retry window; when the push failed or the release got no answer nothing is posted

### Requirement: Worker loop: nothing claimable
On a 404 (nothing claimable, or paused) or a 409 the loop SHALL read `GET /v1/status` and exit 0 when it says `finished`; otherwise it SHALL exit 0 once its idle clock, which a claim or the work verdict restarts, reaches `ORCH_WORKER_IDLE_EXIT_MS` (default 0: never), else wait before the next claim. The wait between claims SHALL start at `ORCH_WORKER_BACKOFF_MS` (default 1000), double after each wait up to `ORCH_WORKER_BACKOFF_MAX_MS` (default 30000), and reset to the first value after a claim.

#### Scenario: No idle exit by default
- **WHEN** every claim answers 404, the status is not finished, and `ORCH_WORKER_IDLE_EXIT_MS` is unset
- **THEN** the loop does not exit for idleness: it keeps claiming, and every wait after the fifth is 30 s

#### Scenario: Backoff reset after a claim
- **WHEN** the loop has waited 1, 2 and 4 s and then claims a launch
- **THEN** the next wait with nothing claimable is 1 s again

### Requirement: Worker loop: refused claim and unanswered calls
A 400 on a claim SHALL end the loop with exit 1. A call that gets no answer SHALL be retried for `ORCH_RETRY_WINDOW_MS` (default 60000), with delays from 100 ms doubling to 1 s; past it the loop SHALL exit 1.

#### Scenario: Daemon unreachable
- **WHEN** no call gets an answer and `ORCH_RETRY_WINDOW_MS` is 2000
- **THEN** the claim is retried after 100, 200, 400 and 800 ms, and then the loop gives up with the connection error, which the bin turns into exit 1

#### Scenario: Claim refused with 400
- **WHEN** a claim is answered 400
- **THEN** the loop prints a `claim-refused` line, the answer on stderr, and exits 1

### Requirement: Worker loop: revoked launch
A 401 on a call made for a launch SHALL end that launch's work, and the loop SHALL claim again.

#### Scenario: Scripted submit answered 401
- **WHEN** the scripted agent's submit for a launch is answered 401 and the status no longer shows the worker holding that launch
- **THEN** the agent ends without retrying, the loop prints `ended` for the launch, releases nothing, and claims again

### Requirement: Worker loop: step lines
The loop SHALL write one line per step to stdout, `worker <id> <event> <launchId> <taskId>` with `-` for a missing id, and SHALL write `report accepted` once for each launch whose submission the daemon accepted; details and the agent's output SHALL go to stderr.

#### Scenario: Lines of an idle loop
- **WHEN** a loop with worker id `w-1` finds nothing claimable until its idle limit passes
- **THEN** its first stdout line is `worker w-1 start - -` and its last is `worker w-1 idle-exit - -`

### Requirement: Worker loop: verdict after the agent
After the agent exits and any fallback report is relayed, the loop SHALL read the status: a task `submitted` or `done` (or a submit answered with `accepted: true`) is `report accepted`; a launch the worker still holds is released without keep with reason `the agent exited without a report`; otherwise the launch has ended.

#### Scenario: Agent exits without a report
- **WHEN** a command agent exits without reporting and the status shows the worker still holding the launch with its task `running`
- **THEN** the loop releases the launch with reason `the agent exited without a report` and no keep, and prints `released`

### Requirement: Worker loop: clone not prepared
A launch whose clone cannot be prepared SHALL be released without keep.

#### Scenario: Claim without a repository URL
- **WHEN** a claim answers a launch that carries no `repoUrl`
- **THEN** the loop prints `checkout-failed`, releases the launch with a reason saying the worker could not prepare its clone and no keep, starts no agent, and claims again

### Requirement: Clone cache: one clone per repository
The loop SHALL keep one clone per `repoUrl` under `ORCH_WORKER_CACHE` (default `/var/cache/orchestrator`), named from the URL and a hash of it, and reuse it across launches; a directory there that is not a clone SHALL be replaced.

#### Scenario: Directory that is not a clone
- **WHEN** the cache directory for a `repoUrl` exists but holds no git clone
- **THEN** the loop removes it and clones `repoUrl` into it before the launch

### Requirement: Clone cache: launch files
After preparing the clone, the loop SHALL write `.orchestrator/brief.md` (the claim's `briefMarkdown`), `.orchestrator/brief.json` (the claim's `brief`, its `worktree` set to the clone) and `.orchestrator/mcp.json` (the MCP shim with `ORCH_API`, the launch id and token, mode 0600).

#### Scenario: Brief points at the clone
- **WHEN** a command agent reads the `.orchestrator/brief.json` its `{briefJson}` slot names
- **THEN** the brief's `worktree` is the clone and its `launchId` is the launch the agent works

### Requirement: Clone cache: remote shim variables
Through `shimEnv` the shim's `env` in `.orchestrator/mcp.json` SHALL also hold `ORCH_ACCESS=remote`, `ORCH_WORKTREE` (the clone) and `ORCH_BRANCH` (the claim's `branch`), so the shim's `report` tool pushes the branch and names `sealedSha` (see specs/agent-protocol "MCP façade").

#### Scenario: Shim pushes and seals
- **WHEN** a command agent commits without pushing and submits through the shim's `report` tool
- **THEN** origin's launch branch is the agent's commit, and the one `agent.report` event of the launch is a `submit` with `seq` 1 and `sealedSha` that commit

### Requirement: Agent command: environment and wait
The agent command SHALL run through `/bin/sh -c` in the clone with the loop's environment plus `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID` and `ORCH_WORKTREE` (the clone), and without the store's connection variables; the loop SHALL wait for the agent command to exit.

#### Scenario: Agent sees its launch
- **WHEN** a command agent records its working directory and its `ORCH_LAUNCH_ID` and `ORCH_WORKTREE`
- **THEN** the working directory and `ORCH_WORKTREE` are the clone, and `ORCH_LAUNCH_ID` is the launch it was started for

### Requirement: Scripted agent: submit retries
A 503 on the scripted agent's submit SHALL be retried with the same seq; a 401 ends the agent.

#### Scenario: Origin briefly unreachable
- **WHEN** the scripted agent's submit is answered 503 and the next one 200
- **THEN** the second submit carries `seq` 1 again, with the same `sealedSha`

### Requirement: Loop heartbeat: fingerprint
Once the clone is prepared, each heartbeat SHALL carry `fingerprint`, the clone's fingerprint computed by the same function the daemon's `GitWorkspace.fingerprint` uses (specs/health-monitoring "Progress signals"), so the same tree gives the same string; it SHALL carry no `progress` text, so it is never a `heartbeatText` signal. A loop heartbeat renews the lease, as every agent call does, and counts as progress only when its fingerprint changed.

#### Scenario: Heartbeat before the clone
- **WHEN** a loop heartbeat falls due before the launch's clone is prepared
- **THEN** its body carries neither `fingerprint` nor `progress`

### Requirement: Loop heartbeat: no overlap
The next loop heartbeat SHALL be timed from the answer to the previous one, so two never overlap.

#### Scenario: Slow answer
- **WHEN** the answer to a loop heartbeat takes longer than `lease.renewEveryMs`
- **THEN** no second heartbeat is sent while it is in flight, and the next one is sent `lease.renewEveryMs` after that answer

### Requirement: Loop heartbeat: stop
The loop heartbeats of a launch SHALL stop when the agent exits, before any fallback report is relayed, and when the clone cannot be prepared.

#### Scenario: Clone fails
- **WHEN** the clone of a claimed launch cannot be prepared
- **THEN** the loop heartbeats of that launch stop before the launch is released, and none is sent after the release

### Requirement: Task filter and launch limit: launch limit
`ORCH_WORKER_MAX_LAUNCHES`, a non-negative integer, SHALL make the loop exit 0 once it has worked that many claimed launches to their end (a report accepted, a release, or an ended launch), without claiming again; unset or 0 SHALL mean no limit. After the limit the loop SHALL print `worker <id> max-launches - -`.

#### Scenario: Three launches
- **WHEN** the loop runs with `ORCH_WORKER_MAX_LAUNCHES=3` and each claimed launch is released
- **THEN** it claims three times, releases the three launches in turn, prints `worker <id> max-launches - -` last and exits 0

#### Scenario: Zero is no limit
- **WHEN** `ORCH_WORKER_MAX_LAUNCHES` is `0`
- **THEN** the settings hold no launch limit, as when it is unset

### Requirement: Worker loop: runner filter
The loop SHALL read `ORCH_WORKER_RUNNER`, one runner kind or a comma-separated list of kinds, and SHALL send it on every claim as `runner`: a string for one kind, a list for several. Unset, the claim SHALL carry no `runner`, and a loop with the `command` agent SHALL write one stderr line at its start that names `ORCH_WORKER_RUNNER` and says it claims launches of every runner kind.

#### Scenario: One kind
- **WHEN** a loop with `ORCH_WORKER_RUNNER=claude-code` claims on a remote run where an `opencode` launch and a `claude-code` launch are claimable
- **THEN** its claim body is `{ workerId, access: 'remote', runner: 'claude-code' }`, it works the `claude-code` launch, and the `opencode` launch stays `claimable`

#### Scenario: Several kinds
- **WHEN** `ORCH_WORKER_RUNNER` is ` codex , opencode `
- **THEN** every claim carries `runner: ['codex', 'opencode']`

#### Scenario: Unset
- **WHEN** a loop with the `command` agent starts without `ORCH_WORKER_RUNNER`
- **THEN** its claims carry no `runner` and its stderr holds one line naming `ORCH_WORKER_RUNNER` and `every runner kind`; a loop with the scripted agent writes no such line

### Requirement: Worker loop: runner filter: malformed value
A value of `ORCH_WORKER_RUNNER` with a part outside the runner kinds, an empty part included, SHALL refuse the start with exit 2 and a message naming `ORCH_WORKER_RUNNER`.

#### Scenario: Unknown kind
- **WHEN** the loop starts with `ORCH_WORKER_RUNNER=gemini` or `ORCH_WORKER_RUNNER=codex,`
- **THEN** it exits 2 with a message naming `ORCH_WORKER_RUNNER` and claims nothing

### Requirement: Worker loop: revoked launch: command agent
When a heartbeat for a launch whose command agent still runs is answered 401, the loop SHALL read `GET /v1/status` once and stop the agent as on termination: SIGTERM to its process group, then SIGKILL after `ORCH_WORKER_AGENT_STOP_MS`. It SHALL print `agent-ended` for the launch, then take the steps after the agent as for any exit. The loop SHALL keep no silence clock of its own.

#### Scenario: Launch cancelled
- **WHEN** the task of a launch whose command agent runs is cancelled and the daemon ticks
- **THEN** within one heartbeat interval and the stop limit the agent is gone, the loop prints `agent-ended` and then `ended`, releases nothing, and claims again

#### Scenario: Launch failed as stuck
- **WHEN** the daemon fails a claimed launch as `stuck` past `health.stuckFailAfterMs`
- **THEN** the next heartbeat is answered 401, the agent is stopped, the task's attempt is spent by the daemon, and the loop releases nothing

#### Scenario: No clock of its own
- **WHEN** the daemon's stuck limits are 0 and a command agent prints nothing for three lease TTLs
- **THEN** the agent still runs and the loop has sent no `GET /v1/status`

### Requirement: Worker loop: revoked launch: report grace
When the status read after the 401 shows the task `submitted` or `done`, the loop SHALL let the command agent run up to 30000 ms more to exit by itself, so its usage object is printed and posted, and SHALL stop it after that. A termination request during the grace SHALL stop it at once.

#### Scenario: Agent lingers after its report
- **WHEN** an agent that submitted keeps running after a heartbeat answered 401
- **THEN** it still runs right after the 401, is stopped once the grace has passed, and the loop prints `agent-ended` and then `report accepted`

#### Scenario: Agent exits within the grace
- **WHEN** an agent that submitted prints its result object and exits within the grace
- **THEN** the loop prints no `agent-ended`, and the launch's usage is recorded with `usageSource` `worker`

### Requirement: Worker loop: revoked launch: unreadable status
When the status read after a heartbeat answered 401 is answered with another status than 200, or not answered, the loop SHALL stop the command agent at once, without the report grace.

#### Scenario: Status answered 500
- **WHEN** the status read after the 401 is answered 500 while the agent's task is submitted
- **THEN** the agent is stopped at once and the loop prints `agent-ended`

### Requirement: Worker loop: nothing claimable: work verdict
The status read SHALL take the strongest (`strongestVerdict`) of `workByKind.<kind>.verdict` over the loop's `ORCH_WORKER_RUNNER` kinds, else every kind. On `finished` the loop SHALL exit 0. On `standby` it SHALL restart its idle clock. `claim`, `human`, `stalled`, `paused` and `idle` SHALL only let the clock run; only a claim that succeeds resets it. A loop with `ORCH_WORKER_TASK` SHALL read only `finished` and keep the plain idle limit.

#### Scenario: Standby holds the idle limit off
- **WHEN** `ORCH_WORKER_IDLE_EXIT_MS` is 120000 and every status answers `standby` for 600 s, then `human`
- **THEN** the loop is still running after 600 s and exits 0 with `idle-exit` 120 s after the last `standby`; likewise for `stalled`, `paused`, `idle`, and `claim` while every claim answers 404

#### Scenario: Task filter keeps the plain limit
- **WHEN** a loop with `ORCH_WORKER_TASK` and `ORCH_WORKER_IDLE_EXIT_MS` 120000 reads `standby` on every status
- **THEN** it exits 0 with `idle-exit` after 120 s, and at once with `finished` when the verdict is `finished`

#### Scenario: Only the loop's kinds count
- **WHEN** a loop with the kinds `codex` and `opencode` reads `standby` for `claude-code` and `idle` for its own kinds
- **THEN** the idle clock runs; a loop with no runner filter takes the strongest verdict of the three kinds

### Requirement: Worker loop: nothing claimable: status without a verdict
A status body without a verdict for any of the loop's kinds (an older daemon) SHALL be read for `finished` alone, and the idle clock SHALL run as before.

#### Scenario: Older daemon
- **WHEN** every claim answers 404 and the status is `{ finished: false }` with `ORCH_WORKER_IDLE_EXIT_MS` 120000
- **THEN** the loop exits 0 with `idle-exit` after 121 s, and with `finished` once the status says `finished: true`
