## 1. Store

- [x] 1.1 `src/state/store.ts`: `VerifierJob` gains optional `offer`, `token`, `verifier` and `result`, each commented with its `verifier-pool` requirement

## 2. Protocol

- [x] 2.1 `src/verify/claims.ts`: `claimVerifyJob`, `verifyHeartbeat`, `postVerifyResult`, `releaseVerifyJob`, `expireVerifyLeases`, `renewVerifyLeases`, `verifyJobChanged`, `wakeVerifyWaiters`
- [x] 2.2 `src/verify/routes.ts`: `registerVerifyRoutes(server, orch)` with the four routes; the bearer read as the `renew` route reads it
- [x] 2.3 `src/loop/orchestrator.ts`: `workerRepoUrl` loses `private`; `recordGaps` calls `renewVerifyLeases(this)` inside its transaction
- [x] 2.4 `src/operator/routes.ts`: `registerOperatorRoutes` calls `registerVerifyRoutes`
- [x] 2.5 `src/loop/tick.ts`: `drainVerification` calls `expireVerifyLeases(o)` first in its `try`

## 3. Tests

- [x] 3.1 `test/loop/verify-claims.test.ts`: nothing offered, grant, repeated claim, refusals, no repository URL, check command, pause and hold, token check, heartbeat, result, result body, release, lease expiry, gap, waiters
- [x] 3.2 `test/slice/verify-routes.test.ts`: the routes over HTTP on a remote run with a bare origin
- [x] 3.3 `test/state/verify-job-fields.test.ts`: the four fields on every store backend
