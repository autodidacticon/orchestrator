## Why

Every limit on a launch was a subtraction of wall-clock times. A machine that sleeps comes back to launches that look silent or overlong, and the first tick after the wake ends them as `stuck`, `timeBudget` or `leaseExpired` and spends their attempts. In the M2 run (2026-11-13, daemon 0.5.1, lid closed for an afternoon) eight launches were ended as stuck and four tasks were blocked as exhausted; five of the eight had been created while the machine was awake for a few seconds and never made a call (ORC-112).

## What Changes

- The daemon notes its clock: a timer every second (or every quarter of `health.gapAfterMs` when shorter), the start of every tick, where reconcile reads the clock, inside the lease-expiry test, and before each use of idle time, elapsed time or the hold. Two consecutive notes more than `health.gapAfterMs` apart are a gap. A note changes memory only.
- The tick writes each gap as a `daemon.gap` event `{ from, to, gapMs, holdUntil }` at its start and again where reconcile reads the clock, and lease expiry writes pending gaps before it tests a lease. The same transaction renews the lease of every live launch holding a `running` or `waiting` task, without recording progress. Writing a gap is activity for idle exit.
- Idle time (stuck limits) and elapsed time (launch time budget) are awake time: wall time less the parts inside gaps, written or not. `waitedMs` grows by awake time. `status().liveLaunches[].idleMs` and `elapsedMs` change meaning in place.
- For `health.gapHoldMs` after a gap nothing starts: no admission, no resume, no spawn of a parked launch, no verifier job and no deferred-job pass. Claims are not held. `idleMs()` is 0 during the hold.
- A new orchestrator reads the run's earlier `daemon.gap` events when it is constructed; they count towards awake time and set no hold.
- Two optional keys, `health.gapAfterMs` and `health.gapHoldMs` (default 60000 each, read at start); `gapAfterMs: 0` turns the rule off, `gapHoldMs: 0` turns the hold off.
- Unchanged: `maxWaitMs`, the report grace, the claim window, push retry backoff, remote git timeouts, the check command's timer and the journal's flush deadline still count wall time.

## Capabilities

### Modified Capabilities

- `health-monitoring`: ADDED "Gap in the daemon's clock" and "Hold after a gap"; MODIFIED "Stuck detection and escalation" and "Launch time budget" (idle and elapsed time are awake time, one gap scenario each).
- `pull-runner`: ADDED "Lease renewal after a gap".

The new requirements name the existing text they except: operator-control "Idle exit", pull-runner "Lease renewal by the work loop" scenario "Renewal stops", health-monitoring "Process liveness" scenario "Unknown liveness falls back to the lease", and the sentence of health-monitoring "Usage accounting" that says `elapsedMs` gives wall time.

## Impact

- New `src/health/gaps.ts` (`GapClock`, `noteIntervalMs`).
- `src/config.ts` (`health.gapAfterMs`, `health.gapHoldMs`, `DEFAULT_GAP_AFTER_MS`, `DEFAULT_GAP_HOLD_MS`).
- `src/loop/orchestrator.ts` (`noteClock`, `awakeMs`, `inHold`, `recordGaps`, `armNoteTimer`, `clearNoteTimer`; idle exit, lease expiry, status, verifier start, start/stop).
- `src/loop/tick.ts` (write points, hold tests, resume), `src/health/stuck.ts` and `src/health/budgets.ts` (`idleMsOf` and `elapsedMs` take the awake clock).
- `test/loop/harness.ts` (`advance` steps and notes; new `sleep`), new `test/health/gaps.test.ts` and `test/loop/gap.test.ts`. README Health paragraph.
