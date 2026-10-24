## 1. Diagnosis

- [x] 1.1 Reproduce the codex-work "two loops" test under parallel load (6 processes × 5 rounds) and record the events before the failure (design.md).
- [x] 1.2 Reproduce the scripted restart failure's mechanism, and record the daemon log of a daemon whose store open overlaps another process creating the store (design.md).

## 2. Implementation

- [x] 2.1 The store sets its busy timeout first and retries the WAL switch and the schema creation while SQLite reports `SQLITE_BUSY` (src/state/sqlite.ts).
- [x] 2.2 `status` reports `verifying`; the digest takes it from there (src/loop/orchestrator.ts, src/operator/routes.ts).
- [x] 2.3 The work loop's stop rule is not quiet while a task is verifying and counts only non-verifying `awaitingReview` entries as reviews (hosts/codex/bin/work.mjs, hosts/claude-code/workflows/work.js).
- [x] 2.4 The restart test waits on the `launch.live` event through `run.waitUntil` and fails fast when the daemon exits; the codex-work test dumps its events when the wait times out.

## 3. Verification

- [x] 3.1 New tests: concurrent open of a new store; `status.verifying`; `stopVerdict` with verifying tasks.
- [x] 3.2 Each of the two tests passes 30 runs under the parallel-load reproduction.
- [x] 3.3 `npx vitest run` without `--retry` passes 5 consecutive full runs.

## 4. Specs

- [x] 4.1 crash-recovery "Store transactions" (MODIFIED), operator-control "Status report" (MODIFIED), host-integration "Work loop by runner kind" (MODIFIED).
