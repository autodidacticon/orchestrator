## Why

The review of milestone 18 found that the shared API client (#183) passes a call's remaining retry window straight to `setTimeout` as the fetch timeout. `ORCH_RETRY_WINDOW_MS` is only checked as non-negative, so a window of 2^31 ms or more is accepted; Node then fires the timer after 1 ms with a `TimeoutOverflowWarning`, and every fetch is aborted and sent again without ever being answered (GH-189).

## What Changes

- `src/worker/http.ts`: the timeout given to `setTimeout` is capped at `MAX_TIMER_MS` (2^31 - 1 ms). The retry window keeps its configured value.
- `test/worker/http.test.ts`: a unit test of the client: the whole window before the signal, a held connection with the 5000 ms floor, the abort and resend of a call in flight at the signal, the short window after it, and the overflow.
- `test/verifier/loop.test.ts`: the fake daemon's `fetch` honors the `AbortSignal`, so the termination cases check the post or claim that is sent again after the signal.
- `deploy/README.md`: the window after the signal is about 6 seconds (5000 ms plus the 1000 ms floor).

Specs:

- verifier-pool: ADDED "Verifier termination: bounded calls: timer cap".

## Impact

- `src/worker/http.ts`, `deploy/README.md`
- `test/worker/http.test.ts`, `test/verifier/loop.test.ts`
