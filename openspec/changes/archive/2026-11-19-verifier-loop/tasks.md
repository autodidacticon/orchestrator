## 1. Loop

- [x] 1.1 `src/verifier/job.ts`: `workVerifyJob(claim, o)` with the job steps, `parseClaim`, `VERIFIER_GIT_TIMEOUT_MS`
- [x] 1.2 `src/verifier/heartbeat.ts`: `startVerifyHeartbeat` for `/v1/verify/<jobId>/heartbeat`
- [x] 1.3 `src/verifier/loop.ts`: `verifierSettings`, `runVerifierLoop`, `USAGE`, the entry block with `--help`, exit 2 on refused settings, SIGTERM and SIGINT

## 2. Package and docs

- [x] 2.1 `package.json`: bin `orchestrator-verifier` at `dist/src/verifier/loop.js`
- [x] 2.2 `README.md`: the `npm link` line and a paragraph on the verifier loop

## 3. Tests

- [x] 3.1 `test/verifier/loop.test.ts`: settings, sweep, waits and exits, claim answers, heartbeat, results and releases, termination
- [x] 3.2 `test/verifier/job.test.ts`: verified, failed check, rebase, nothing to check, origin, abort, environment
- [x] 3.3 `test/slice/verifier-loop.test.ts`: green, red and termination against a daemon with `verifier.mode: remote`
- [x] 3.4 `test/host/package.test.ts`: seven executables, `--help`, symlink and the shebang line
