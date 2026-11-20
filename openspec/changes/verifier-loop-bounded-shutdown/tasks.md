## 1. Client

- [x] 1.1 `src/worker/http.ts`: `apiClient` with `termination`, the per-call deadline, the per-fetch `AbortSignal` and timeout; `TERMINATION_CALL_MS` moved here and re-exported by `src/worker/terminate.ts`

## 2. Loops

- [x] 2.1 `src/verifier/loop.ts`: one termination-aware client; `requested()` tested after the pause; release with `podTerminating` after a post refused after the signal
- [x] 2.2 `src/worker/loop.ts`: one termination-aware client; a claim with no answer after the signal exits 0

## 3. Tests

- [x] 3.1 `test/verifier/loop.test.ts`: refused posts (400, 503, no answer), signal in the pause, claim and result post never answered with a 60 s window
- [x] 3.2 `test/worker/loop.test.ts`: claim never answered with a 60 s window
