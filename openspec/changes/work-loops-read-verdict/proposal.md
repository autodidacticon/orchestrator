## Why

After #192 the daemon serves a work verdict per runner kind (`workByKind` in `GET /v1/status`). The two loops that read the status still classify the run themselves, and the remote loop (`orchestrator-worker`) leaves by its idle limit while a launch of its kinds is being prepared, worked or verified (GH-194). The owner decided on 2026-11-19 that the daemon classifies and each loop reacts.

## What Changes

- `hosts/codex/bin/work.mjs`: `stopVerdict` reads `workByKind.<kind>.verdict` when the status carries it: `finished`, `stalled` and `human` stop with today's sentences, `idle` stops after `--idle-exit-ms`, and `claim`, `standby`, `paused` and an unknown word keep the loop polling with the idle timer reset. A status without the verdict goes through today's rule unchanged.
- `src/worker/loop.ts`: new `statusVerdict(body, runnerKinds)`, the strongest verdict (`strongestVerdict`) over `ORCH_WORKER_RUNNER`'s kinds, else every kind. The loop exits 0 on `finished` (the field or the verdict) and restarts its idle clock while the verdict is `standby`, except with `ORCH_WORKER_TASK`. `claim`, `human`, `stalled`, `paused` and `idle` let the clock run. The `USAGE` line of `ORCH_WORKER_IDLE_EXIT_MS` says so.
- `deploy/README.md` "The workers": what the idle limit counts.
- Tests: `test/host/work-stop.test.ts` (new), `test/worker/loop.test.ts`; the cases of `test/worker/heartbeat.test.ts`, `test/slice/worker-loop.test.ts` and `test/slice/worker-shim.test.ts` that ended their loop by the idle limit while a task was `submitted` now end by `ORCH_WORKER_MAX_LAUNCHES`, and a new slice case reaches `idle-exit` with nothing under verification.

Specs:

- host-integration: MODIFIED "Work loop by runner kind: stop rule"; ADDED "Work loop by runner kind: stop rule without a verdict".
- worker-pool: MODIFIED "Worker loop" and "Worker loop: nothing claimable"; ADDED "Worker loop: nothing claimable: work verdict" and "Worker loop: nothing claimable: status without a verdict".

## Impact

- `hosts/codex/bin/work.mjs`, `src/worker/loop.ts`, `deploy/README.md`
- `test/host/work-stop.test.ts`, `test/worker/loop.test.ts`, `test/worker/heartbeat.test.ts`, `test/slice/worker-loop.test.ts`, `test/slice/worker-shim.test.ts`
