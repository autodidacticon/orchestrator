## 1. Tell the worker

- [x] 1.1 Claim response carries `leaseTtlMs`, `leaseExpiresAt` and `lease { ttlMs, expiresAt, renewEveryMs }` (`Orchestrator.leaseFacts`, `claimResponse`)
- [x] 1.2 Brief Reporting section names the interval (`leaseRule`, `BriefInput.leaseTtlMs`, `brief.json` `leaseTtlMs`)
- [x] 1.3 `hosts/claude-code/workflows/work.js`: the claimer returns the lease numbers; the worker prompt states the TTL and the interval and says to background long commands
- [x] 1.4 `hosts/codex/bin/work.mjs`: the preamble states the TTL and the interval from the claim
- [x] 1.5 MCP `claim` and `launch_heartbeat` descriptions name the interval

## 2. Renew from the loop

- [x] 2.1 `Orchestrator.renewClaim` and `POST /v1/launches/:id/renew` (bearer token; 401, 409; not a progress signal)
- [x] 2.2 `startRenewal` in `work.mjs`: timer at `renewEveryMs` while the child lives; stops on exit, 401, 404 and 409

## 3. Expire gently

- [x] 3.1 `Orchestrator.expireClaim`: progress (a commit or a dirty file) under the bound is a kept release; otherwise `leaseExpired` failure
- [x] 3.2 `reconcile` calls it for claimed launches

## 4. Tests and record

- [x] 4.1 `test/loop/lease.test.ts`: claim facts, renewal not progress (stuck), gone loop expires within TTL plus a tick, kept on commit or dirty file, failed without progress, bound
- [x] 4.2 `test/host/work-loop.test.ts`: a silent agent under the loop outlives several TTLs; a killed loop's claim expires; renewal timer unit tests
- [x] 4.3 `openspec validate pull-lease-renewal --strict`
