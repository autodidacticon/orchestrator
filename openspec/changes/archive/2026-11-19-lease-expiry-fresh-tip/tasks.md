## 1. Fresh tip per lease expiry

- [x] 1.1 Tag a tick's branch tip read with the lease's `expiresAt` in `Origin.branchTipFromTick`; drop a read under another tag and start a new one
- [x] 1.2 Pass the lease's `expiresAt` from `expireRemoteClaim`
- [x] 1.3 Drop the launch branch's read in `Orchestrator.endLaunch`

## 2. Tests

- [x] 2.1 `test/slice/remote-release.test.ts`: an old "no tip" and an old sha from before a renewed lease do not decide the next expiry
- [x] 2.2 `test/slice/remote-release.test.ts`: a launch ended by an accepted submit, a release and an operator cancel drops its read

## 3. Spec

- [x] 3.1 Modify `pull-runner` "Lease expiry" and add the scenario "Remote expiry after a renewed lease"
