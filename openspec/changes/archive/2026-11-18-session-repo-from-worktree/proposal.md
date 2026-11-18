## Why

Every agent of one Claude Code session shares one `orchestrator-mcp` server, and the server remembers the last `repo` any call passed as the session's repository. It kept `git rev-parse --show-toplevel` of that path, which for a launch worktree (a linked worktree of the repository, under the run directory) is the worktree itself. A pull-mode worker that passed its worktree as `repo` therefore moved the session to a repository with no run, and the operator's next `ack` and `wait` without `repo` failed with `no running daemon for .../worktrees/<launchId> ...; call the start tool first` (seen 2026-11-17 during the CLOUD-M3 run; ORC-141).

## What Changes

- A `repo` inside a linked worktree resolves to the main working tree of its repository: the directory above `git rev-parse --git-common-dir` when that is not the path's own git directory (and is named `.git`). A path in the main working tree resolves as before. The new resolver is `repoOfWorktree` in `src/runs/runDir.ts`; `gitTopLevel` and `resolveRepoPath` are unchanged.
- The worker tools (`claim`, `release`, `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, `launch_log`) use a `repo` they are passed for that call only and never change the session repository. Operator tools keep the existing rule.
- No change to the daemon, the run id, or `orchestrator-ctl`.

## Impact

- `src/runs/runDir.ts` (new `repoOfWorktree`), `src/operator/mcp-server.ts` (`useRepo`, `WORKER_TOOL_NAMES`).
- Tests: `test/runs/repo-of-worktree.test.ts`; a new case in `test/slice/operator-mcp.test.ts`.
- Spec `operator-mcp`: requirement "Operator MCP server".
