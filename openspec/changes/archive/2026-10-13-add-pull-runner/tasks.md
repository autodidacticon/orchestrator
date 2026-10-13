## 1. Modes and claimable launches

- [x] 1.1 Add `runner: { mode: 'spawn' | 'pull' | 'mixed', claimWindowMs }` to `src/config.ts` with defaults `spawn` and 60000, and document both keys in the README configuration line
- [x] 1.2 Durable mode override: kv `runner.mode` read by `Orchestrator.effectiveMode()` in `src/loop/orchestrator.ts`; `src/main.ts` accepts `--mode` and writes the kv; `src/operator/routes.ts` adds `PUT /v1/runner { mode }` recorded as an operator event
- [x] 1.3 `src/state/store.ts`: `LaunchStatus` gains `claimable`; `Launch` gains `claimableAt` and `worker: { id, claimedAt }`; `listLaunches` accepts the new status; `src/state/sqlite.ts` keeps both inside the JSON document, no migration
- [x] 1.4 Split `src/launch/launch.ts` into `prepareLaunch` (row, `launch.afterRow`, worktree and brief, then `claimable` with `crashPoint('launch.afterClaimable')` in pull or mixed, or straight to spawn) and `spawnLaunch` (the existing `launching`, spawn, pid sequence); add both points to `CRASH_POINTS` in `src/crash.ts`
- [x] 1.5 `src/loop/tick.ts` phase 4: spawn parked launches whose window has elapsed (zero in spawn, `claimWindowMs` since `claimableAt` in mixed, never in pull), skipped while paused, before admitting new work
- [x] 1.6 `src/loop/tick.ts` phase 1: a live launch with a worker and no pid is judged by its lease only, never as a dead process, and never has a fallback file read; `Orchestrator.stop({ reap })` leaves claimed launches alone
- [x] 1.7 `src/loop/orchestrator.ts`: renew the lease at admission when a claimed launch resumes from `waiting`; append `launch.claimable` events; `authenticate` keeps rejecting the token of a `claimable` launch
- [x] 1.8 Tests in `test/loop/modes.test.ts` on the in-process harness: pull parks and never spawns; mixed spawns after the window; spawn unchanged; capacity counts parked launches; a parked launch outlives the lease TTL; a mode switch drains parked launches; pause holds them; reap leaves a claimed launch live
- [x] 1.9 Tests in `test/slice/launch.test.ts`: launch records pass through `preparing`, `claimable`, `live` with a worker in pull mode and through `preparing`, `claimable`, `launching`, `live` with a pid when a mixed window elapses, with the brief present before the claim

## 2. Claim and release

- [x] 2.1 `src/state/transitions.ts`: add `running -> unstarted` by the orchestrator with trigger `released` and no effects; `src/state/status.ts`: add `FailedKind` `released`; extend `test/state/transitions.test.ts`
- [x] 2.2 `src/loop/orchestrator.ts` `claim({ workerId, taskId?, access })`: `access` defaults to `local` and `remote` answers 501; pick the oldest claimable launch by `createdAt` or the named task's; 404 when none or when paused, 409 naming the launch state otherwise
- [x] 2.3 Claim record: one transaction setting the launch `live` with `worker`, resetting the lease to `leaseTtlMs` from now with `spawnedAt` unset, and appending `launch.claimed`; `crashPoint('claim.afterRecord')`; respond with `{ launchId, taskId, token, worktree, briefPath, brief, baseSha, apiUrl }`, reading `brief.json` from the worktree
- [x] 2.4 Idempotent re-claim: a worker holding a live launch gets it back with the same token when `taskId` is absent or matches, 409 otherwise; include `pending: { seq, question, answer? }` from the waiting status or `pendingAnswer`
- [x] 2.5 `src/loop/orchestrator.ts` `release(launchId, reason)`: progress from the health-monitoring fingerprint since `claimedAt` and agent events under the launch; no progress ends the launch `released`, transitions to `unstarted`, and removes the worktree; progress calls `fail` with kind `released`; `waiting` degrades to `blocked` with the question; 409 for launches without a worker
- [x] 2.6 `src/operator/routes.ts`: `POST /v1/claims` and `POST /v1/launches/:id/release` with operator events before effects; `status` gains `runner`, `claimable` in claim order, and `workers`; `digestOf` gains `claimable`
- [x] 2.7 `src/operator/cli.ts`: `claim`, `release`, and `mode` subcommands over the routes; usage text updated
- [x] 2.8 Tests in `test/slice/claim.test.ts` over the real API with launches parked in pull mode: claim ordering; named-task claim; 404 and 409; 501 for remote; idempotent re-claim with the same token; re-claim carries a pending answer; release without progress returns to `unstarted` and re-prepares with `launches` increased; release after a commit fails the attempt with the reason in the next brief; release while waiting blocks; paused claim is 404; status and digest fields

## 3. Recovery and the crash suite

- [x] 3.1 `src/launch/recovery.ts`: keep `claimable` launches, verify the worktree and brief, re-prepare when missing; `src/workspace/workspace.ts` gains `exists(launch)`; `src/workspace/git-workspace.ts` makes `prepare` tolerate an existing branch by resetting it to `baseSha`; `src/workspace/fake.ts` follows
- [x] 3.2 `src/launch/recovery.ts`: keep a live launch with a worker while its lease is unexpired, fail an expired one with `leaseExpired` and remove its worktree; never read a fallback file for it
- [x] 3.3 Include `claimable` in the live set of the recovery sweep and of any periodic sweep so parked worktrees are never removed
- [x] 3.4 `test/agents/worker.ts`: a scripted worker process that loops claim, commit, submit over HTTP with a fixed worker id, retrying connection failures through daemon restarts, re-claiming after 401, and exiting when the digest reports finished or stalled
- [x] 3.5 `test/crash/harness.ts`: a `pull` option that writes `runner.mode: pull` and starts two scripted workers beside the daemon; `test/crash/crash.test.ts`: the matrix in pull mode over every crash point including `launch.afterClaimable` and `claim.afterRecord`, with the same invariants
- [x] 3.6 Tests in `test/slice/claim-recovery.test.ts`: a restart keeps a parked launch claimable; a deleted worktree is re-prepared for the same launch; a restart keeps a claimed launch live and its next call succeeds; an abandoned claim expires into a failed attempt and a new claimable launch

## 4. Operator MCP worker tools

- [x] 4.1 `src/operator/mcp-server.ts`: `claim { workerId, taskId?, access? }` and `release { launchId, reason }` over the routes; add them to `TOOL_NAMES`
- [x] 4.2 `src/operator/mcp-server.ts`: `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, `launch_log`, each `{ launchId, token, ...body }` with the body schemas from `src/agent/mcp-shim.ts`, forwarding to `/v1/launches/:id/<op>` with the bearer token
- [x] 4.3 `launch_block`: abort the forwarded request at `WAIT_CAP_MS` and return `{ pending: true, seq }`; otherwise return the daemon's response unchanged
- [x] 4.4 `start` gains `mode`: `src/runs/lifecycle.ts` `startDaemon` passes `--mode` when it spawns and calls `PUT /v1/runner` when the daemon is already healthy; `src/operator/mcp.ts` usage lists the new tools
- [x] 4.5 Tests in `test/slice/worker-tools.test.ts` over a real stdio client where the harness is the worker: tool list; `start` with mode pull; `import_graph`; `claim`; commit in the worktree; `launch_block` returns pending, `answer`, the same seq returns the answer; `launch_report` rejected 409 for a dirty worktree, repaired by a commit and the same seq; verification publishes with trailers; `release`; 401 after release; `start` with a mode on the running daemon changes `status.runner.mode`

## 5. Host: work skill, workflow, marketplace

- [x] 5.1 Write `hosts/claude-code/skills/work/SKILL.md`: prerequisites (`npm link` or a global install, a loaded graph), `start` with mode, worker count against capacity, the run tag, running the bundled workflow, answering questions and re-running with the same tag, review, stopping conditions, outcomes rather than briefs in the conversation
- [x] 5.2 Write `hosts/claude-code/workflows/work.js`: `meta`, `parallel` over `args.workers` loops with ids `${args.runTag}-${i}`, a shared `held` map, the termination rule, and a short outcome per cycle
- [x] 5.3 `work.js` prompts: a low-effort claimer agent with a schema returning the claim fields or the digest after a bounded `wait`; a worker agent prompt composed from the brief plus tool instructions (ordinary tools in the worktree, commit on the launch branch, `launch_block` loop while pending, `launch_report` with acceptance evidence, commit and resubmit with the same seq on 409, no fallback file, stop on 401)
- [x] 5.4 Add `.claude-plugin/marketplace.json` at the repository root listing `orchestrator` with `source: "./hosts/claude-code"`; README gains the marketplace install, the work skill, and the executables-on-PATH prerequisite
- [x] 5.5 Tests in `test/host/package.test.ts`: `claude plugin validate --strict hosts/claude-code` passes with the skill and workflow present; the marketplace manifest parses and names the plugin and source; `hosts/claude-code/.claude-plugin/plugin.json` version equals `package.json` version
- [x] 5.6 Scripted end to end `test/e2e/scripted-work.test.ts`: mixed mode with a short window, one scripted worker and the scripted agent runner on a three-task graph; the worker takes what it can, the daemon spawns the rest, and the integration branch carries one trailer commit per task
- [x] 5.7 Opt-in end to end `test/e2e/work.test.ts` (`ORCH_E2E_CLAUDE_WORK=1`): a real Claude Code session with `--plugin-dir hosts/claude-code` runs the work skill with two workers on a three-task graph in pull mode; assert every task done and one trailer commit per task on the integration branch; document in README
- [x] 5.8 Before archiving: re-read `openspec/specs/task-lifecycle/spec.md` and fold into this change's MODIFIED `Transition table enforcement` block any rows and scenarios that `add-graph-mutation` added (cascade reset, milestone reset) if it was archived first; sync replaces the block wholesale
