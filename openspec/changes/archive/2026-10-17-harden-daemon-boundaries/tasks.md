## 1. Child environment

- [x] 1.1 New `src/runs/childEnv.ts`: `childEnv(dataDir, extra?)` returns `process.env` plus `extra` with `ORCH_HOME=<dataDir>/child-home` and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` set to `''`; `stripEmpty(env)` deletes empty values; export from `src/index.ts`
- [x] 1.2 `src/loop/orchestrator.ts` `agentEnv` adds the isolation keys from `childEnv` (the runner already deletes empty values); `src/verify/verifier.ts` `runCheck` builds its env through `childEnv` + identity and strips empties
- [x] 1.3 Tests: `test/slice/launch.test.ts` scripted `runnerCommand` writes `$ORCH_HOME` and `${ORCH_URL:-unset}` to the worktree and the test asserts the data-directory path and `unset`; `test/slice/verifier.test.ts` real verifier with `checkCommand: 'echo "$ORCH_HOME" > home.txt && test -z "$ORCH_URL"'` passes and the job's tree does not include the file (it is written after sealing, in the temp worktree, so assert through the check's success and a second check that fails on `test -n "$ORCH_URL"`)

## 2. Shutdown attribution

- [x] 2.1 `src/runs/runDir.ts` `ExitRecord.by?: { attachment?, remote?, userAgent? }`; `src/loop/orchestrator.ts` `requestShutdown(reason, reap, by?)`; `src/main.ts` passes `by` into the exit record; `src/operator/routes.ts` shutdown handler reads the header, remote address, and user agent, appends `operator.shutdown { reap, by }`, and passes `by`
- [x] 2.2 `src/runs/lifecycle.ts`: the revival refusal names `by.attachment` or `by.remote` when present; `runs` already returns the exit record whole
- [x] 2.3 Tests: `test/slice/config.test.ts` or a new `test/slice/shutdown.test.ts`: `POST /v1/shutdown` with `x-orch-attachment: a1` leaves `operator.shutdown` in the events and `exit.by` in `daemon.json` with attachment `a1`, remote `127.0.0.1`; the revival error mentions `a1`

## 3. Finish

- [x] 3.1 `npm run build`; `npm test` green; `openspec validate harden-daemon-boundaries`; README "Behaviour" sentence on the isolated child environment and attributed shutdown. Outcome: 410 passed; the two known load flakes (`test/slice/launch.test.ts` missing-acceptance-evidence, `test/crash/crash.test.ts` launch.afterSpawn) failed in the full run and passed alone; no spawned test agent reads the removed variables
