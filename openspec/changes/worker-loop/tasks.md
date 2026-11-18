## 1. Loop

- [x] 1.1 `workerSettings`: `ORCH_API`, worker id from `POD_NAME`, `ORCH_WORKER_ID` or the host name, cache, agent, command, idle exit, retry window, backoff
- [x] 1.2 `runWorkerLoop`: claim with `access: remote`; on 404/409 read status, exit 0 when finished or idle past the limit, else back off 1 s doubling to 30 s, reset after a claim; 400 exits 1
- [x] 1.3 One stdout line per step, `worker <id> <event> <launchId> <taskId>`, `report accepted` once per accepted submission
- [x] 1.4 Bin `orchestrator-worker` -> `dist/src/worker/loop.js`

## 2. Clone cache

- [x] 2.1 One clone per `repoUrl` under the cache, reused; `.orchestrator/` in `.git/info/exclude`
- [x] 2.2 Per launch: fetch, checkout `-B <branch>` at `carry.interrupted.headSha` or `baseSha`, clean except `.orchestrator/`, stale `report.json` removed
- [x] 2.3 `brief.md`, `brief.json`, `mcp.json` (0600)

## 3. Agents

- [x] 3.1 `substitute` and `fixedSlots` move to `src/runner/command.ts`; `composeAgentCommand` calls them
- [x] 3.2 Command agent through `/bin/sh -c` in the clone, with the launch's `ORCH_*` variables and no store variables
- [x] 3.3 Scripted agent: README line, commit, push, submit with `sealedSha` and evidence by position

## 4. After the agent

- [x] 4.1 Fallback relay: post `report.json` with the launch token, delete it; fill `sealedSha` from HEAD (pushed) when missing
- [x] 4.2 Status: reported, held (release without keep) or ended

## 5. Tests

- [x] 5.1 `test/worker/loop.test.ts`: settings, fake-clock backoff and idle exit, finished exit, connection retries, composition through the shared functions, start commit, launch state
- [x] 5.2 `test/slice/worker-loop.test.ts`: two scripted loops over a three-task chain, interrupted head as branch start, fallback relay, clone reuse with a clean tree
