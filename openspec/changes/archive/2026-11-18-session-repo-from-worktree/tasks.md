## 1. Resolver

- [x] 1.1 `repoOfWorktree` in `src/runs/runDir.ts`: the main working tree for a path in a linked worktree, the real top level otherwise
- [x] 1.2 `useRepo` resolves through `repoOfWorktree`

## 2. Worker tools

- [x] 2.1 `WORKER_TOOL_NAMES`; a worker tool's `repo` binds the call without changing the session repository

## 3. Tests

- [x] 3.1 `test/runs/repo-of-worktree.test.ts`: worktree path, main working tree, subdirectory, symlinks, outside git
- [x] 3.2 `test/slice/operator-mcp.test.ts`: worktree as `repo` reaches R's daemon and keeps the session on R; a worker tool's `repo` (another repository, or outside git) fails for that call only

## 4. Spec

- [x] 4.1 Modify `operator-mcp` "Operator MCP server"
