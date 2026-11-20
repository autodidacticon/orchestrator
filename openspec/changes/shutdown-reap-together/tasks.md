## 1. Runner

- [x] 1.1 `killTrees(pids, graceMs)` in `src/runner/subprocess.ts`, `killTree` on top of it, `SubprocessRunner.reapAll`
- [x] 1.2 `reapAll` on `AgentRunner`, in `RUNNER_METHODS`, in `MultiRunner` and `InprocRunner`

## 2. Shutdown

- [x] 2.1 `Orchestrator.stop`: one `reapAll` for the live launches no worker holds, then usage, task and end per launch; the reap before the prepare and verifier waits

## 3. Tests

- [x] 3.1 `test/agents/term-agent.ts`
- [x] 3.2 `test/runner/reap-all.test.ts`: five groups, mixed group, MultiRunner dispatch and rejection
- [x] 3.3 `test/loop/shutdown-reap.test.ts`: one call and event order, verifier job in flight, `RUNNER_METHODS`
- [x] 3.4 `test/slice/shutdown-reap.test.ts`: three launches in the harness, five launches in a foreground daemon with `--reap-on-exit`
