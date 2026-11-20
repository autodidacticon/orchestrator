## Why

Two requirements archived with M5 describe the same stop differently (GH-185, follow-up of #163 and #32). operator-control "Shutdown: reap before the verifier wait" says the verifier job in flight still runs to its end. verifier-pool "Remote verification and restarts: stop" says `stop()` ends a run that waits for a result at once, and its scenario says `stop()` returns within one second. The code (`Orchestrator.stop` at fba912b) does both: it waits for the tick in flight, reaps on a reaping stop (`reapLive`), stops the prepare commands (`stopPrepareJobs`), wakes the remote waiters (`wakeVerifyWaiters`) and then waits for the verifier job. A local check runs to its end; a remote wait ends at once after the reap. The one-second scenario cannot hold while the reap (up to one kill grace plus 1000 ms) or a prepare command (up to 5000 ms) is still being stopped.

## What Changes

- operator-control "Shutdown: reap before the verifier wait": a local verifier job in flight still runs to its end, or until the shutdown deadline; a remote run that waits for a result ends at once, as verifier-pool "Remote verification and restarts: stop" says. Its scenario names a local verifier job, and a second scenario covers the remote wait.
- verifier-pool "Remote verification and restarts: stop": the scenario counts its second from the moment the reap and the prepare-command stop end.
- No code changes (owner decision, 2026-11-19).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `operator-control`: MODIFIED "Shutdown: reap before the verifier wait".
- `verifier-pool`: MODIFIED "Remote verification and restarts: stop".

## Impact

- Specs only. No file under `src/` or `test/` changes.
