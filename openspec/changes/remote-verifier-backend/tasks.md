## 1. Contract

- [x] 1.1 `src/verify/job.ts`: optional `VerifierContext.awaitResult`, `VerifierStoppedError`, `NO_CLAIM`

## 2. Backend

- [x] 2.1 `src/verify/remote.ts`: `RemoteVerifierBackend` (offer, wait, result mapping, verify ref check, deletion)

## 3. Configuration

- [x] 3.1 `src/config.ts`: `verifier: { mode }` and `remoteVerifierError`
- [x] 3.2 `src/main.ts`: the refusal before anything listens, and the choice of backend

## 4. Daemon

- [x] 4.1 `src/loop/orchestrator.ts`: `awaitResult`, the resume in the single slot, `VerifierStoppedError` in the catch, `NO_CLAIM` at six writes, refusal in `start()`, wake in `stop()`, drop of offered jobs in `cancel()`
- [x] 4.2 `src/launch/recovery.ts`: the kept offered job and `NO_CLAIM` at four writes

## 5. Docs and tests

- [x] 5.1 README: "Verifier mode." and "Child processes"
- [x] 5.2 `test/slice/remote-verifier.test.ts` and `test/loop/verifier-mode.test.ts`
