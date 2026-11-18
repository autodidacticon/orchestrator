## Why

Workers that run off the daemon's machine (a cluster pod, another host) cannot use a worktree the daemon prepares. The claim's `access: 'remote'` was reserved with a 501 so a later change could implement it without changing the request shape (ORC-11, cloud-native M3).

## What Changes

- New file key `runner.access: local | remote` (default `local`), read at start. It is not a runtime override and is not in `configure`.
- Startup refuses `runner.access: remote` unless the runner mode in force is `pull`, `git.pushIntegration` is true and `prepareCommand` is unset; the message names each unmet condition. `PUT /v1/runner` refuses a mode other than `pull` on a remote run with 409.
- `Launch.access` is set when the row is created and never changes; a row without it is `local`. Launch rows are JSON documents, so no migration is added.
- For a remote launch `prepareLaunch` creates no worktree: `worktree` is the empty string and the composed brief is stored on the row as `briefMarkdown` and `briefJson`.
- New `RemoteWorkspace` (`src/workspace/remote-workspace.ts`) with no-op `prepare`, `remove`, `fingerprint` and `exists` (true); `seal`, `preserve` and `readFallback` reject with `remote launch has no worktree`. The daemon keeps its `GitWorkspace` for the verifier and the integration branch; launch-side calls go through the workspace chosen by `launch.access`.
- A claim whose `access` differs from the run's answers 409 with `{ reason, access, runAccess }` and changes nothing. The 501 is gone. Until ORC-16, a matching remote claim answers with the local response shape.

## Capabilities

### New Capabilities

- `remote-workspace`: the workspace of a remote launch, the brief on the launch row, workspace chosen by access.

### Modified Capabilities

- `pull-runner`: "Access modes" rewritten: remote is no longer reserved; the run's access, the startup conditions and the 409 on a mismatched claim.

## Impact

- `src/config.ts` (`runner.access`, `remoteAccessProblems`, `remoteAccessError`), `src/state/store.ts` (`Launch.access`, `briefMarkdown`, `briefJson`, `accessOf`), `src/launch/launch.ts` (`prepareLaunch`, `remoteBrief`), `src/workspace/remote-workspace.ts`, `src/loop/orchestrator.ts` (workspace routing, claim, start), `src/operator/routes.ts` (`PUT /v1/runner`).
- Seal and report handling (ORC-18), release and lease expiry (ORC-23), the claim response shape (ORC-16) and the remote brief text (ORC-17) are left to their tasks: until then a remote launch's submit, release with keep and lease expiry cannot read a tree.
- Tests: `test/slice/remote-access.test.ts`; the two tests that asserted the 501 now assert the 409.
