## 1. Origin

- [x] 1.1 `Origin.branchTip(branch)`: `ls-remote` of `refs/heads/<branch>` on the serial chain, undefined when absent, `OriginFetchError` otherwise

## 2. Release

- [x] 2.1 The release route, the MCP `release` tool and `orchestrator-ctl release` carry `headSha` and `wipCommit`
- [x] 2.2 `releaseRemote`: 400 on a malformed sha; progress by call or by `headSha` against the base; bound before origin; fetch and compare through `RemoteWorkspace.seal`, answering its refusals with `sealRefusal`; re-check the lease after the fetch; no fingerprint, preserve or remove

## 3. Lease expiry

- [x] 3.1 `Origin.branchTipFromTick`: started reads awaited at most `tickWaitMs`, not at all while origin is busy; startup recovery awaits `branchTip` in full
- [x] 3.2 `expireRemoteClaim`: tip at origin; kept at a tip other than the base, failed otherwise; skipped while origin is unreadable until expiry plus one TTL; no preserve or remove

## 4. Tests

- [x] 4.1 `test/slice/remote-release.test.ts`: kept release and next claim, 409s, no-progress keep, counting workspace, bound, expiry kept/failed, origin unreachable, MCP schema
