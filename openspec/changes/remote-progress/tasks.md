## 1. Daemon

- [x] 1.1 `treeFingerprint(dir)` in `src/workspace/fingerprint.ts`; `GitWorkspace.fingerprint` delegates to it
- [x] 1.2 `observeFingerprint` returns a remote launch unread; `applyFingerprint` holds the baseline / `commit` / `worktree` compare
- [x] 1.3 A remote heartbeat with `fingerprint`: 400 when malformed, else `applyFingerprint` (plus `heartbeatText` for new text) and no plain `heartbeat` signal; a local one ignores it

## 2. Worker loop

- [x] 2.1 `startLoopHeartbeat`: every `lease.renewEveryMs` (else `lease.ttlMs / 3`) from the claim until the agent exits, with the clone's fingerprint once the clone exists; stops on 401; never overlaps
- [x] 2.2 `workLaunch` starts it at the claim and stops it before the fallback relay

## 3. Tests

- [x] 3.1 `test/health/progress.test.ts`: counting workspace on reconcile; remote heartbeat signals; local heartbeat ignored; stuck with and without changing fingerprints, remote and local
- [x] 3.2 `test/worker/heartbeat.test.ts`: fake clock shared with a real daemon; three silent TTLs; control without heartbeats; 401; one fingerprint function
