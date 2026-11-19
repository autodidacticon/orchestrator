## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Six of the 10 requirements of `worker-pool` are over the limit: "Worker loop" (1886 characters), "Clone cache" (1199), "Agent command" (757), "Scripted agent" (543), "Loop heartbeat" (1100) and "Task filter and launch limit" (659). This change splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (#139, task GH-177 / ORC-177).

## What Changes

- MODIFIED, six requirements: "Worker loop", "Clone cache", "Agent command", "Scripted agent", "Loop heartbeat" and "Task filter and launch limit". Each keeps its header and every scenario, names and texts unchanged; its description is cut to one behavior of at most 500 characters (447, 455, 470, 465, 431 and 344 characters).
- ADDED, fifteen requirements, each named "<MODIFIED name>: <behavior>", one per behavior removed from a MODIFIED description. Each holds the moved sentences, unchanged or with only their references made explicit, a description of 71 to 489 characters with SHALL, and at least one new scenario with WHEN and THEN.
- No sentence of the originals is over 500 characters on its own (the longest is 470), so none is split. No lead-in is added and no SHALL is given at a joint: the one moved sentence without SHALL ("A loop heartbeat renews the lease, ...", the last sentence of "Loop heartbeat") is carried by the SHALL sentence "Once the clone is prepared, each heartbeat SHALL carry `fingerprint`, ..." (the second sentence of the original), which it now follows directly.
- No SHALL or MUST is dropped: the six original descriptions hold 41, and the cut descriptions (14) and the ADDED descriptions (27) hold 41. Nothing is removed or renamed, and no other requirement changes ("Worker identity", "Fallback relay", "Pod termination" and "Usage post" are untouched).

### Moved sentences

Each sentence moved out of a MODIFIED description, and the ADDED requirement that now holds it. Every other sentence stays in its MODIFIED description, unchanged.

### Worker loop

Stay: "The `orchestrator-worker` bin ... SHALL run the remote worker loop ...", "Each round SHALL `POST /v1/claims` ...", "A 200 SHALL be worked as one launch ... and the loop SHALL claim again." and "Heartbeats from the loop, pod termination and usage are not part of this requirement."

- "On a 404 (nothing claimable, or paused) or a 409 the loop SHALL read `GET /v1/status` and exit 0 when it says `finished`; otherwise it SHALL exit 0 when nothing has been claimed for `ORCH_WORKER_IDLE_EXIT_MS` (default 0, which never exits for idleness), and else wait before the next claim." → "Worker loop: nothing claimable", unchanged
- "The wait SHALL start at `ORCH_WORKER_BACKOFF_MS` (default 1000), double after each wait up to `ORCH_WORKER_BACKOFF_MAX_MS` (default 30000), and reset to the first value after a claim." → "Worker loop: nothing claimable" (reference made explicit: "The wait" becomes "The wait between claims")
- "A 400 on a claim SHALL end the loop with exit 1." → "Worker loop: refused claim and unanswered calls", unchanged
- "A call that gets no answer SHALL be retried for `ORCH_RETRY_WINDOW_MS` (default 60000), with delays from 100 ms doubling to 1 s; past it the loop SHALL exit 1." → "Worker loop: refused claim and unanswered calls", unchanged
- "A 401 on a call made for a launch SHALL end that launch's work, and the loop SHALL claim again." → "Worker loop: revoked launch", unchanged
- "The loop SHALL write one line per step to stdout, `worker <id> <event> <launchId> <taskId>` with `-` for a missing id, and SHALL write `report accepted` once for each launch whose submission the daemon accepted; details and the agent's output SHALL go to stderr." → "Worker loop: step lines", unchanged
- "After the agent exits and any fallback report is relayed, the loop SHALL read the status: a task `submitted` or `done` (or a submit answered with `accepted: true`) is `report accepted`; a launch the worker still holds is released without keep with reason `the agent exited without a report`; otherwise the launch has ended." → "Worker loop: verdict after the agent", unchanged
- "A launch whose clone cannot be prepared SHALL be released without keep." → "Worker loop: clone not prepared", unchanged

### Clone cache

Stay: "The clone's `.git/info/exclude` SHALL list `/.orchestrator/`." and "Before each launch the loop SHALL abort an operation ... and remove a stale `.orchestrator/report.json`."

- "The loop SHALL keep one clone per `repoUrl` under `ORCH_WORKER_CACHE` (default `/var/cache/orchestrator`), named from the URL and a hash of it, and reuse it across launches; a directory there that is not a clone SHALL be replaced." → "Clone cache: one clone per repository", unchanged
- "It SHALL then write `.orchestrator/brief.md` (the claim's `briefMarkdown`), `.orchestrator/brief.json` (the claim's `brief`, its `worktree` set to the clone) and `.orchestrator/mcp.json` (the MCP shim with `ORCH_API`, the launch id and token, mode 0600)." → "Clone cache: launch files" (references made explicit: "It SHALL then write" becomes "After preparing the clone, the loop SHALL write")
- "Through `shimEnv` the shim's `env` there SHALL also hold `ORCH_ACCESS=remote`, `ORCH_WORKTREE` (the clone) and `ORCH_BRANCH` (the claim's `branch`), so the shim's `report` tool pushes the branch and names `sealedSha` (see specs/agent-protocol "MCP façade")." → "Clone cache: remote shim variables" (reference made explicit: "there" becomes "in `.orchestrator/mcp.json`")

### Agent command

Stays: "With `ORCH_WORKER_AGENT=command` the loop SHALL compose `ORCH_WORKER_COMMAND` ...; a slot with no value stays as written."

- "The command SHALL run through `/bin/sh -c` in the clone with the loop's environment plus `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, `ORCH_TASK_ID` and `ORCH_WORKTREE` (the clone), and without the store's connection variables; the loop SHALL wait for it to exit." → "Agent command: environment and wait" (references made explicit: "The command" becomes "The agent command", "it" becomes "the agent command")

### Scripted agent

Stays: "With `ORCH_WORKER_AGENT=scripted` the loop SHALL run the scripted agent in `src/worker/` ...: it SHALL append one line ... named by its position."

- "A 503 on the submit SHALL be retried with the same seq; a 401 ends the agent." → "Scripted agent: submit retries" (reference made explicit: "the submit" becomes "the scripted agent's submit")

### Loop heartbeat

Stay: "From the claim until the agent exits, the worker loop SHALL send `POST /v1/launches/:id/heartbeat` ... during a long silent step." and "A heartbeat answered 401 SHALL end the heartbeats for that launch."

- "Once the clone is prepared, each heartbeat SHALL carry `fingerprint`, ... so it is never a `heartbeatText` signal." → "Loop heartbeat: fingerprint", unchanged
- "A loop heartbeat renews the lease, as every agent call does, and counts as progress only when its fingerprint changed." → "Loop heartbeat: fingerprint", unchanged; it has no SHALL of its own and is carried by the "Once the clone is prepared, ..." SHALL sentence, the second of the original, which it now follows directly instead of coming last (449 characters together)
- "The next heartbeat SHALL be timed from the answer to the previous one, so two never overlap." → "Loop heartbeat: no overlap" (reference made explicit: "The next heartbeat" becomes "The next loop heartbeat")
- "The heartbeats SHALL stop when the agent exits, before any fallback report is relayed, and when the clone cannot be prepared." → "Loop heartbeat: stop" (reference made explicit: "The heartbeats" becomes "The loop heartbeats of a launch")

### Task filter and launch limit

Stay: "The worker loop SHALL read two optional variables.", "`ORCH_WORKER_TASK`, when set to a non-empty value, SHALL be sent as `taskId` in every claim, ...; a claim answered 404 or 409 is waited on as any other." and "A malformed `ORCH_WORKER_MAX_LAUNCHES` SHALL be refused at start, naming the variable, with exit 2."

- "`ORCH_WORKER_MAX_LAUNCHES`, a non-negative integer, SHALL make the loop exit 0 once it has worked that many claimed launches to their end (a report accepted, a release, or an ended launch), without claiming again; unset or 0 SHALL mean no limit." → "Task filter and launch limit: launch limit", unchanged
- "After the limit the loop SHALL print `worker <id> max-launches - -`." → "Task filter and launch limit: launch limit", unchanged

### Splits, lead-ins and SHALL at a joint

None: no sentence is over 500 characters, no moved bullet needs a lead-in, and no moved text needed SHALL of its own.

### Where each new scenario comes from

At the base commit 65a28cc:

- "No idle exit by default": `test/worker/loop.test.ts` ("never exits on idleness with ORCH_WORKER_IDLE_EXIT_MS 0 (the default)").
- "Backoff reset after a claim": `test/worker/loop.test.ts` ("the backoff resets to the first delay after a claim"), `src/worker/loop.ts` (`runWorkerLoop` calls `backoff.reset()` after a 200).
- "Daemon unreachable": `test/worker/loop.test.ts` ("retries a connection failure within ORCH_RETRY_WINDOW_MS, then gives up with the error": delays 100, 200, 400, 800 and a rejection), `src/worker/loop.ts` (the entry point exits 1 on a rejection), `src/worker/http.ts` (`apiClient`).
- "Claim refused with 400": `src/worker/loop.ts` (`runWorkerLoop`: a 400 logs `claim-refused` with the answer as its detail and returns 1).
- "Scripted submit answered 401": `src/worker/scripted.ts` (`runScriptedAgent` returns undefined on a 401), `src/worker/loop.ts` (`workClaimed`: not accepted, `launchState` `ended` logs `ended` and releases nothing; `runWorkerLoop` claims again), `test/worker/loop.test.ts` ("reads reported, held or ended from the status").
- "Lines of an idle loop": `test/worker/loop.test.ts` ("waits 1, 2, 4 s and doubling up to the 30 s cap, and exits 0 after ORCH_WORKER_IDLE_EXIT_MS": first line `worker w-1 start - -`, last `worker w-1 idle-exit - -`).
- "Agent exits without a report": `test/slice/worker-usage.test.ts` ("no report: ... the launch is released as today": stderr `released: the agent exited without a report -> 200`), `src/worker/loop.ts` (`release` posts `{ workerId, reason }` with no keep).
- "Claim without a repository URL": `test/worker/loop.test.ts` (`grantingDaemon` hands out claims without `repoUrl`, and "ORCH_WORKER_MAX_LAUNCHES: exits 0 after that many launches" sees each released before the next claim), `src/worker/loop.ts` (`workClaimed`: `checkout-failed`, then `release` with "the worker could not prepare its clone").
- "Directory that is not a clone": `src/worker/clone.ts` (`ensureClone` removes a directory without a working `.git` and clones into it).
- "Brief points at the clone": `test/slice/worker-loop.test.ts` ("reuses one clone for two launches in a row ...": `briefWorktree` is the clone and `briefLaunchId` the launch), `src/worker/loop.ts` (`writeLaunchFiles`).
- "Shim pushes and seals": `test/slice/worker-shim.test.ts` ("the agent commits without pushing and submits through the report tool ...": origin's branch tip is the agent's head and the one `agent.report` is `{ kind: 'submit', seq: 1, sealedSha: tip }`).
- "Agent sees its launch": `test/slice/worker-loop.test.ts` ("reuses one clone for two launches in a row ...": the agent's `cwd` is the clone and its `env` is `{ ORCH_LAUNCH_ID, ORCH_WORKTREE: clone }`), `src/worker/loop.ts` (`agentEnv`).
- "Origin briefly unreachable": `src/worker/scripted.ts` (`runScriptedAgent` retries a 503 with the same body, `seq` 1 and the `sealedSha` computed once).
- "Heartbeat before the clone": `src/worker/loop.ts` (`startLoopHeartbeat`: the body is `{}` while `clone()` is undefined, and never has `progress`).
- "Slow answer": `src/worker/loop.ts` (`startLoopHeartbeat`: `arm` schedules the next heartbeat `everyMs` after the previous one settles).
- "Clone fails": `src/worker/loop.ts` (`workClaimed` awaits `stopHeartbeat()` before `release` when the clone cannot be prepared; `stop` cancels the next heartbeat and awaits one in flight).
- "Three launches": `test/worker/loop.test.ts` ("ORCH_WORKER_MAX_LAUNCHES: exits 0 after that many launches, without claiming again").
- "Zero is no limit": `test/worker/loop.test.ts` ("reads ORCH_WORKER_TASK and ORCH_WORKER_MAX_LAUNCHES, ...": `ORCH_WORKER_MAX_LAUNCHES` `0` gives `maxLaunches` undefined).

## Capabilities

### New Capabilities

### Modified Capabilities

- `worker-pool`: "Worker loop", "Clone cache", "Agent command", "Scripted agent", "Loop heartbeat" and "Task filter and launch limit" have their descriptions cut to one behavior each; the moved behaviors become fifteen ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-worker-pool/`. No code changes. The backlog fixes of #163, #164 and #165 are not made here; "Pod termination" is untouched.
