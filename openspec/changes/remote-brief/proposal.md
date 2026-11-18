## Why

A remote worker (ORC-11) works in its own clone on another machine. The brief composed for it still named the daemon's worktree path, the loopback API URL and an absolute fallback path inside that worktree, none of which exist or are reachable for the worker (ORC-17, cloud-native M3).

## What Changes

- `composeBrief` writes a remote Workspace section for a launch with `access: remote`: the clone (the current directory, a clone the worker loop made), the branch, the base commit, the integration branch, and that work is submitted by committing on the branch and pushing it to `origin` before `report submit`. It names no daemon path.
- `remoteBrief` composes with the API URL `apiBaseUrl` (trailing slashes stripped) and the fallback path `.orchestrator/report.json`, which the brief says is relative to the clone's root; `briefJson` carries the same values. The OpenSpec rule follows the daemon's clone.
- For a carry holding `interrupted`, the remote brief says the branch starts at `carry.interrupted.headSha`, not at the base.
- Startup of a remote run is also refused when `apiBaseUrl` is unset, or when the kind in force has commit policy `daemon`; both are added to `remoteAccessProblems` after ORC-11's conditions.
- On a remote run, admission blocks a task whose runner kind has commit policy `daemon` with the new orchestrator-only blocked kind `remoteNeedsAgentCommit` (trigger of the same name, `unstarted -> blocked`), creating no launch.
- Local briefs are byte-for-byte unchanged.

## Capabilities

### Modified Capabilities

- `agent-protocol`: "Standalone brief" (the requirement that lists the brief's contents) gains the remote brief.
- `pull-runner`: new requirement "Remote run requirements". "Access modes" is left to the unarchived change `remote-access-mode`, which modifies it.
- `task-lifecycle`: "Transition table enforcement" gains the `remoteNeedsAgentCommit` row; "Structured blocked reasons" gains the kind.

## Impact

- `src/brief/compose.ts`, `src/launch/launch.ts` (`remoteBrief`), `src/config.ts` (`remoteAccessProblems`, `commitPolicyOfKind`), `src/loop/orchestrator.ts` (`start`, `commitPolicyFor`), `src/loop/tick.ts` (admission), `src/state/status.ts`, `src/state/transitions.ts`.
- Tests: `test/loop/remote-brief.test.ts`; `test/slice/remote-access.test.ts` sets `apiBaseUrl` on its remote runs and lists the new condition.
