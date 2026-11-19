## 1. Shim

- [x] 1.1 `src/agent/remote-submit.ts`: dirty check (`dirtyFiles` outside `.orchestrator/`), forced push bounded at 60 s, `HEAD`; refusals 409 `dirtyWorktree`, 503 `pushFailed`, 500 `gitFailed`
- [x] 1.2 `src/agent/mcp-shim.ts`: `ORCH_ACCESS`, `ORCH_WORKTREE`, `ORCH_BRANCH` in `ShimEnv` and `envFromProcess`; the remote branch of `report`; the remote description; `USAGE`

## 2. Loop and brief

- [x] 2.1 `src/worker/loop.ts` `writeLaunchFiles`: the three variables through `shimEnv`'s `extra`
- [x] 2.2 `src/brief/compose.ts`: the remote Submit line; `test/loop/remote-brief.test.ts` follows it

## 3. Image and notes

- [x] 3.1 `deploy/worker-claude/Dockerfile`
- [x] 3.2 `deploy/README.md`: "Claude worker image" and "The workers"

## 4. Tests

- [x] 4.1 `test/slice/shim-remote.test.ts`: accepted submit, dirty clone, failed push, git failure, rewritten branch, fail report, start
- [x] 4.2 `test/slice/worker-shim.test.ts` with `test/agents/mcp-report-agent.ts`
- [x] 4.3 `test/host/worker-image.test.ts`
