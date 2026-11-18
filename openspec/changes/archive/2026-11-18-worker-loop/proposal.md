## Why

A remote run (ORC-11) parks launches for workers that have no worktree on the daemon's host. ORC-16 gave the claim what such a worker needs (`repoUrl`, the brief, `carry`), ORC-17 the brief text and ORC-18 the seal of a pushed branch, but nothing runs on the worker side yet. A cluster needs a binary that claims, prepares a clone, runs an agent and claims again, and the M3 smoke test needs one that works without a model (ORC-22, cloud-native M3).

## What Changes

- New bin `orchestrator-worker` (`dist/src/worker/loop.js`, source `src/worker/loop.ts`): the remote worker loop.
  - Environment: `ORCH_API` (required); worker id from `POD_NAME`, else `ORCH_WORKER_ID`, else the host name; `ORCH_WORKER_CACHE` (default `/var/cache/orchestrator`); `ORCH_WORKER_AGENT` `scripted` or `command` (default `command`); `ORCH_WORKER_COMMAND` (the template, required for `command`); `ORCH_WORKER_IDLE_EXIT_MS` (default 0, never); `ORCH_RETRY_WINDOW_MS` (default 60000); `ORCH_WORKER_BACKOFF_MS` and `ORCH_WORKER_BACKOFF_MAX_MS` (default 1000 and 30000).
  - Loop: `POST /v1/claims { workerId, access: 'remote' }`; on 404 (or 409) read `/v1/status`, exit 0 when `finished`, exit 0 when idle for `ORCH_WORKER_IDLE_EXIT_MS`, else wait 1 s doubling to 30 s; the delay resets after a claim. Connection failures are retried for the retry window.
  - Per claim: one clone per `repoUrl` in the cache, reused; `git fetch origin`, `git checkout -f -B <branch> <start>` where start is `carry.interrupted.headSha` or `baseSha`, `git clean -ffdx` except `.orchestrator/`, which `.git/info/exclude` lists. `.orchestrator/brief.md`, `brief.json` (with `worktree` the clone) and `mcp.json` (the MCP shim with the launch token, mode 0600) are written.
  - `command`: the template is composed by `substitute` and `fixedSlots`, which move from `src/runner/subprocess.ts` to `src/runner/command.ts` (re-exported from `subprocess.ts`), with the clone as `{worktree}` and the brief's `allowedTools` in `{allowedTools}`; run through `/bin/sh -c` in the clone, its output on the loop's stderr.
  - `scripted` (`src/worker/scripted.ts`): appends one README line naming the task, commits, force-pushes the launch branch to origin, and submits with `sealedSha` and evidence per criterion by position.
  - After the agent: a `.orchestrator/report.json` is posted to the launch's report route (a `block` to the block route) with the launch token and deleted; a submit without `sealedSha` gets the clone's HEAD, pushed to the launch branch first. The status then decides: `report accepted` when the task is submitted or done (or the submit answered `accepted`), a release (no keep) when the worker still holds the launch, else `ended`.
  - One stdout line per step, `worker <id> <event> <launchId> <taskId>` (`-` for none); details and agent output on stderr.
- `shimEnv` takes any value with `launchId` and `token`.
- Heartbeats from the loop are ORC-26; pod termination and usage are M4 (ORC-28, ORC-29); the shim's remote mode is ORC-27; a kept release of a remote launch is ORC-23.

## Capabilities

### New Capabilities

- `worker-pool`: the remote worker loop, its identity, clone cache, agent command, scripted agent and fallback relay.

### Modified Capabilities

None.

## Impact

- New `src/worker/loop.ts`, `src/worker/clone.ts`, `src/worker/http.ts`, `src/worker/scripted.ts`; `src/runner/command.ts` (`substitute`, `fixedSlots`), `src/runner/subprocess.ts` (imports and re-exports them), `src/runner/shim-command.ts` (`shimEnv` parameter type); `package.json` (bin); `README.md` (one sentence, the `npm link` list).
- Tests: `test/worker/loop.test.ts`, `test/slice/worker-loop.test.ts`, `test/agents/fallback-agent.ts`; `test/host/package.test.ts` lists six bins.
