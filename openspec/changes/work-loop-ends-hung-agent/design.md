## Context

The work loop (`hosts/codex/bin/work.mjs`) runs one agent CLI per claimed launch and, before this change, waited for it to exit. A claimed launch has no pid in the daemon (`launch.worker` set, `launch.pid` undefined), so the daemon can fail it but never end the process that works it.

## What the daemon does with a silent claimed launch today

Read from `src/loop/tick.ts` `reconcile` (the `launch.worker && launch.pid === undefined` branch) and `src/health/stuck.ts`, and observed in the host tests of this change:

1. **The lease is renewed only by contact.** Every agent API call renews it (`Orchestrator.renewLease`), and so does a change of the worktree fingerprint seen at a tick. The fingerprint ignores `.orchestrator/`, so the loop's log and prompt files there are not progress. An agent that has hung makes no call and changes nothing.
2. **Stuck detection does apply to a claimed launch** while its task is `running`: `checkTimeBudget`, then `checkStuck`. The comment at `tick.ts:108` ("its lease is the only bound on silence") understates this. `checkStuck` flags at `health.stuckAfterMs` and fails at `health.stuckFailAfterMs` via `failStuck`, which calls `runner.reap` (a no-op for a launch without a pid, `SubprocessRunner.reap`), fails the task with reason `stuck`, ends the launch `stuck`, and removes the worktree.
3. **The lease expires while the loop holds the claim.** Once `lease.expiresAt <= now` and the task still runs on that launch, the daemon records usage, fails the task `leaseExpired` (trigger `deadOrExpired`), ends the launch `leaseExpired`, and removes the worktree. The task is relaunched while attempts remain.
4. **Nobody tells the process.** In every case the agent keeps running in a removed worktree and the loop keeps waiting on it; the relaunch sits claimable until another loop takes it.

With the defaults (`leaseTtlMs` 10 min, `stuckAfterMs` 15 min, `stuckFailAfterMs` 45 min) the lease is the binding limit. In the e2e (also `leaseTtlMs` 10 min) the last contact was the refused submit just before the 07:11:58 stream error, so the daemon would have failed the launch `leaseExpired` about ten minutes later, around 07:22, while the loop went on waiting until teardown. The e2e printed no stderr and kept no store, so that last step is inferred from the code, not observed.

Event evidence, from the host tests `work loop ends a hung agent (ORC-79)` in `test/host/work-loop.test.ts` (a fake `opencode` that never writes and never exits; `leaseTtlMs` 1500 with stuck detection off, then `leaseTtlMs` 60 s with `stuckFailAfterMs` 1500):

```
lease expiry                                              stuck detection
seq 6  launch.claimed  {workerId: hg-1, access: local}     seq 6  launch.claimed  {workerId: hg-1, access: local}
seq 7  transition      running -> failed  deadOrExpired    seq 7  transition      running -> failed  stuck
seq 8  transition      failed -> unstarted  retry          seq 8  transition      failed -> unstarted  retry
seq 9  launch.ended    {endReason: leaseExpired}           seq 9  launch.ended    {endReason: stuck}
seq 10 transition      unstarted -> running  admitted      seq 10 transition      unstarted -> running  admitted
seq 11 launch.created  {attempt: 2, launchNo: 2}           seq 11 launch.created  {attempt: 2, launchNo: 2}
seq 12 launch.claimable                                    seq 12 launch.claimable
```

No `operator.release` follows: the daemon's verdict is final, and before this change the loop held the dead launch's agent forever (the same tests time out at `waitFor` when the watcher is disabled).

## Decisions

**Watch through `GET /v1/status`, every `--poll-ms`.** The status already carries what the loop needs (`workers` with each worker's launch, `byStatus`), the loop uses it for `stillHeld`, and one call per running agent every two seconds is cheap. `launchState` reads it as `running`, `waiting` (both still held), `reported` (the task submitted or is done), or `ended` (anything else: failed, stuck, lease expired, cancelled, released, or relaunched on a launch this worker does not hold). An unreachable daemon counts as `running`, so only the silence limit applies then.

**Not every ended launch is a hang.** Right after a submit the daemon ends the launch `reported` at the next tick, while the agent is still printing its last output, which is where opencode's usage comes from. A `reported` launch therefore gets 30 s (`REPORT_GRACE_MS`) before its agent is ended, and that outcome stays `started`. Every other `ended` state ends the agent at once.

**Silence is measured on the agent's output** (stdout and stderr, which is what the log file receives) and is not counted while the task is `waiting`: an agent in `block` prints nothing for up to `maxWaitMs`.

**Where the limit comes from.** The brief asks for the daemon's stuck-fail threshold from the claim. The claim response (`Orchestrator.claimResponse`) carries `maxWaitMs` and `retryWindowMs` but no health thresholds, and neither does the config report, and `src/` is outside this change's scope. The loop therefore reads `claim.health.stuckFailAfterMs` when present (a later daemon can send it with no loop change), lets `--max-silence-ms` override it, and otherwise uses 45 minutes, the daemon's default `stuckFailAfterMs`. Under the daemon's own thresholds the daemon-ended path already applies them: whichever of lease expiry and stuck-fail fires first ends the launch, and the loop follows within one poll. The silence limit is the bound for the case the daemon cannot see: an agent kept alive by its MCP shim (a renewed lease) whose CLI writes nothing.

**Release without keep.** A launch the loop ended for silence while still holding it is released with `keep: false` and a reason naming the silence. The agent ran and did not report, which is the existing `noReport` case; keep is for interruptions the agent did not cause (the loop's own SIGTERM, a session ending) and is bounded by `daemon.maxKeptReleases`, so a model that hangs every time would otherwise spin through kept releases. With no progress the release returns the task to `unstarted` at no cost; with progress it is a failed attempt, as the daemon's stuck verdict would be. A launch the daemon ended is not released: the daemon has already recorded its verdict.

**Outcome `hung` counts toward `--max-failures`**, so a model that hangs on every launch stops the loop rather than burning every attempt; the classification of the output is skipped, because a killed agent that never wrote would otherwise read as `exitBeforeTurn` and be released as a start failure with keep.

**Process group, SIGTERM then SIGKILL.** The agent is spawned detached, so `-pid` is its group: the shell, the CLI and its MCP children. SIGKILL follows after 5 s (`KILL_GRACE_MS`) even when the shell has already gone, because the CLI it started may ignore SIGTERM and hold the pipes open. The signal path uses the same helper, so a stopping loop also escalates.

## E2E stderr

Both work e2es set a `passed` flag at the end of the try block and, in `finally`, print the last 16000 characters of the loop's stderr with `console.error` when it is unset, so a `waitFor` timeout (which throws before any `expect` that names stderr) shows the loop's view.
