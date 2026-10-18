## 1. Grace after report

- [x] 1.1 `src/config.ts`: `health.reportGraceMs` (integer, non-negative, default 30000); `src/state/store.ts`: `Launch.reportedAt?: number`; `acceptSubmission` in `src/loop/orchestrator.ts` sets it when the submit is recorded
- [x] 1.2 `src/loop/tick.ts` reconcile: in the cancelled-or-superseded branch, `continue` while the entry is `submitted` or `done`, the process is alive, and `now - reportedAt < reportGraceMs`; everything else unchanged
- [x] 1.3 `test/loop/harness.ts`: `health.reportGraceMs: 0` in the defaults; new test in `test/loop/health.test.ts` with a positive grace: the launch stays live after submit, `runner.die()` then a tick records the scripted usage and ends `reported`; a second task's launch is reaped and ended once `advance()` passes the grace; a cancelled task's launch is reaped immediately

## 2. Finish

- [x] 2.1 `npm run build`; `npm test` green, gated on the test command's own exit status; `openspec validate keep-usage-on-report`. Outcome: 412 passed; the one failure in the full run was the known load flake in `test/slice/launch.test.ts` (missing-acceptance-evidence), which passed alone. Five test files that build their own `health` config literal gained `reportGraceMs: 0` so in-process scenarios keep their immediate-end timing
