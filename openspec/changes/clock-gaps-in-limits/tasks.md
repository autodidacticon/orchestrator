## 1. Gap arithmetic and configuration

- [x] 1.1 `src/health/gaps.ts`: `GapClock` with `note`, `load`, `pending`, `written`, `awakeMs`, `inHold`, `lastGapEnd`; `noteIntervalMs`; no store and no limit
- [x] 1.2 `health.gapAfterMs` and `health.gapHoldMs`, optional, with `DEFAULT_GAP_AFTER_MS` and `DEFAULT_GAP_HOLD_MS` next to `DEFAULT_CONTENDED_RETRIES` (`src/config.ts`)

## 2. Orchestrator

- [x] 2.1 `noteClock`, `awakeMs`, `inHold`, `recordGaps` (one transaction: events, lease renewals; then activity), earlier gaps loaded in the constructor
- [x] 2.2 `armNoteTimer` and `clearNoteTimer`, called by `start()` and `stop()` (and on idle exit)
- [x] 2.3 `idleMs()` is 0 during the hold and counts the latest gap's end as activity; `startVerifierIfIdle` returns during the hold; `expireClaim`'s test notes and writes first; `status()` notes before computing idle and elapsed time

## 3. Tick and checks

- [x] 3.1 `runTick` and `reconcile` note and write gaps (at the start and where `now` is taken)
- [x] 3.2 `idleMsOf` and `elapsedMs` take the awake clock; `checkStuck` and `checkTimeBudget` note the clock first; the resume adds awake time to `waitedMs`
- [x] 3.3 The hold in `admitAndLaunch`, before each resume, each new launch and each spawn in `spawnDueLaunches`

## 4. Tests and docs

- [x] 4.1 `Harness.advance` steps by at most half of `health.gapAfterMs` and notes; `Harness.sleep` jumps
- [x] 4.2 `test/health/gaps.test.ts` and `test/loop/gap.test.ts`
- [x] 4.3 README Health paragraph
