## 1. Configuration

- [x] 1.1 `runner.access` (`local | remote`, default `local`) with an error naming the key (`src/config.ts`)
- [x] 1.2 `remoteAccessProblems` / `remoteAccessError`, checked first in `Orchestrator.start()` against the mode in force
- [x] 1.3 `PUT /v1/runner` refuses a mode other than `pull` on a remote run

## 2. Launch row

- [x] 2.1 `Launch.access`, `briefMarkdown`, `briefJson` and `accessOf` (`src/state/store.ts`); no migration
- [x] 2.2 `prepareLaunch` sets `access`; a remote launch gets an empty `worktree` and its composed brief on the row

## 3. Workspace

- [x] 3.1 `RemoteWorkspace` and `workspaceByAccess` (`src/workspace/remote-workspace.ts`)
- [x] 3.2 The orchestrator wraps its workspace with `workspaceByAccess`; a claim response never reads a brief from an empty worktree path

## 4. Claim

- [x] 4.1 A claim whose `access` differs from the run's answers 409 with `reason`, `access` and `runAccess`; the 501 is removed

## 5. Tests

- [x] 5.1 `test/slice/remote-access.test.ts`: config key, each startup refusal, remote admission, restart, mismatched claims both ways, `RemoteWorkspace`
- [x] 5.2 The 501 assertions in `test/slice/claim.test.ts` and `test/loop/modes.test.ts` assert the 409
