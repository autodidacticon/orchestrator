## 1. Code

- [x] 1.1 `src/config.ts`: `prepareCommand` and `prepareTimeoutMs` beside `checkCommand`
- [x] 1.2 `src/verify/verifier.ts`: `runCheck` options `label`, `signal`, `closeWaitMs`; `spawnError` on a spawn error
- [x] 1.3 `src/launch/prepare.ts`: prepare jobs, `startPrepareCommand`, `settlePrepareJobs`, `spawnPreparedLaunches`, `abandonPrepare`, `stopPrepareJobs`, the default runner
- [x] 1.4 `src/state/transitions.ts`: `running -> unstarted`, orchestrator, `prepareFailed`
- [x] 1.5 `src/loop/core.ts` and `src/launch/launch.ts`: `startPrepareCommand` on the core; `startLaunch` returns while the command runs; `parkLaunch` extracted
- [x] 1.6 `src/loop/tick.ts`: settle after reconcile; the spawn pass spawns prepared launches and starts the command for a parked launch it took back; `removeOrRetryLater` and `abandonSpawn` exported
- [x] 1.7 `src/launch/recovery.ts`: parked launches the command has not run for end as `notPrepared`
- [x] 1.8 `src/loop/orchestrator.ts`: `prepareJobs`, `prepareRunner`, `prepareStopWaitMs`, `stop()` aborts and waits, `stopping` cleared before recovery, test helpers `prepareStarted()` and `prepareSettled()`

## 2. Tests

- [x] 2.1 `test/loop/prepare.test.ts`: unset key, background run, spawn per runner kind, pull, capacity, failure, reasons, throwing clean test, cancel and cascade, cancel before spawn, pause, hold, mixed, stop, recovery of parked launches
- [x] 2.2 `test/slice/prepare.test.ts`: ignored install tree and environment, label and kill, dirty, timeout, exit, `runCheck` abort and held pipe
- [x] 2.3 `test/state/transitions.test.ts`: the new row
