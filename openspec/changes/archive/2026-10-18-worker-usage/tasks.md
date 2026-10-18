## 1. Daemon

- [x] 1.1 `src/loop/orchestrator.ts`: split `recordUsage` into the runner read (skipping a claimed launch) and `storeUsage`; add `workerUsageBodySchema` and `recordWorkerUsage`
- [x] 1.2 `src/operator/routes.ts`: `POST /v1/launches/:id/usage`, recorded as `operator.usage`

## 2. Tests

- [x] 2.1 `test/loop/health.test.ts`: a claimed launch ends with no usage; the matching worker's post records it with `source: 'worker'`; a second post is a no-op; another worker, a launch with a pid, and a bad body are refused; the spawned launch still reads its runner
- [x] 2.2 `test/slice/claim.test.ts`: the route over the real API after submit, priced into `status.cost`

## 3. Finish

- [x] 3.1 Spec deltas for pull-runner, health-monitoring, and operator-control; `openspec/specs/` is updated when the change is archived
- [x] 3.2 The Codex work loop (codex-work-loop) posts the summed `turn.completed.usage` after `codex exec` exits
