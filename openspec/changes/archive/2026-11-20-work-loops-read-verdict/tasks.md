## 1. orchestrator-work

- [x] 1.1 `stopVerdict` reads `workByKind.<kind>.verdict`; a status without it keeps today's rule
- [x] 1.2 `test/host/work-stop.test.ts`: every verdict, the verdict winning over other fields, `--runner opencode`

## 2. orchestrator-worker

- [x] 2.1 `statusVerdict`: the strongest verdict over the loop's kinds, else every kind
- [x] 2.2 Exit on `finished`; restart the idle clock on `standby` unless `ORCH_WORKER_TASK` is set
- [x] 2.3 `USAGE` and `deploy/README.md` say what the idle limit counts
- [x] 2.4 `test/worker/loop.test.ts`: verdict, task filter, kinds and `USAGE` cases
- [x] 2.5 The heartbeat, worker-loop and worker-shim cases that idled out with a task `submitted` end by `ORCH_WORKER_MAX_LAUNCHES`; one slice case reaches `idle-exit` with nothing under verification
