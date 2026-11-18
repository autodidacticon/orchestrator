## 1. Origin

- [x] 1.1 `Origin.fetchBranch(branch)`: one serialized forced fetch of `refs/heads/<branch>` into the clone's `refs/heads/<branch>`, answering the tip, undefined when origin has no such branch, `OriginFetchError` otherwise

## 2. Remote seal

- [x] 2.1 `SealOptions.sealedSha` and the `RemoteSealRefusal` variants of `SealResult` (`src/workspace/workspace.ts`)
- [x] 2.2 `RemoteWorkspace` takes the daemon's `Origin`; `seal` fetches and compares, answering `branchNotPushed`, `shaMismatch`, `originUnreachable` or `originRefused`; without a `sealedSha` or an origin it still rejects with `remote launch has no worktree`
- [x] 2.3 `remoteSealedSha` in `src/agent/seal.ts`: required, full hex object name, lower-cased

## 3. Report handling

- [x] 3.1 `handleReport` answers 400 naming `sealedSha` on a remote submit without one, before any fetch; a local submit ignores it
- [x] 3.2 `sealRefusal`: 409 for `dirtyWorktree`, `branchNotPushed` and `shaMismatch`; 503 for `originUnreachable` and `originRefused`; nothing recorded on any refusal
- [x] 3.3 The orchestrator builds its remote workspace with the shared origin
- [x] 3.4 The operator MCP `launch_report` tool declares `sealedSha` and passes it through

## 4. Tests

- [x] 4.1 `test/slice/remote-seal.test.ts`: accepted and published remote submit, `branchNotPushed`, `shaMismatch`, missing `sealedSha`, unreachable origin, `emptySubmission`, local submit ignores `sealedSha`, `RemoteWorkspace.seal` failure mapping, `launch_report` schema carries `sealedSha`
