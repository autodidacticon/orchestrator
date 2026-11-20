## 1. Client

- [x] 1.1 Cap the fetch timer of `apiClient` at `MAX_TIMER_MS` (2^31 - 1 ms); the retry window is unchanged

## 2. Tests

- [x] 2.1 `test/worker/http.test.ts`: the window before the signal, a held connection with the 5000 ms floor, a call in flight at the signal, a call started after it, and a 3e9 ms window
- [x] 2.2 `test/verifier/loop.test.ts`: the fake daemon honors the `AbortSignal`, and the refused-post cases assert the post sent again

## 3. Docs

- [x] 3.1 `deploy/README.md`: about 6 seconds after the signal (5000 ms plus the 1000 ms floor)
- [x] 3.2 `openspec validate api-client-timer-cap --strict`
