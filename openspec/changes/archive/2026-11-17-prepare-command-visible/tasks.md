## 1. Daemon

- [x] 1.1 `elapsedMs` starts at `spawnedAt ?? claimableAt ?? createdAt`
- [x] 1.2 `StatusReport` and `status()`: `preparing`, `prepareRetry`, `preparingByKind`
- [x] 1.3 Wait digest and the bodies without a graph
- [x] 1.4 `status` tool description names the three fields

## 2. Work loops and texts

- [x] 2.1 `stopVerdict` counts `preparingByKind[kind]`
- [x] 2.2 The Claude Code workflow claimer counts `preparingByKind["claude-code"]`
- [x] 2.3 The five stop texts; the OpenCode pinned block's hash re-pinned

## 3. Brief

- [x] 3.1 `BriefInput.prepareCommand`, the Definition of done bullet and the `brief.json` field
- [x] 3.2 `briefInput` fills `prepareCommand` when the key is set

## 4. Tests

- [x] 4.1 `test/loop/prepare-status.test.ts`: status, digest, restart, mixed mode, time budget
- [x] 4.2 `test/host/work-loop.test.ts`, `test/loop/brief.test.ts`, `test/slice/operator-mcp.test.ts`
