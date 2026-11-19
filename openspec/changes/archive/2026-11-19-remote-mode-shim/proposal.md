## Why

A remote submit must carry `sealedSha`, the tip the worker pushed (ORC-18), but the MCP shim's `report` tool forwards its arguments as they are and declares no `sealedSha`. An agent that follows the remote brief and reports through the tool is answered 400; CLOUD-M3 passed with scripted agents only. A Claude agent in a pod also needs an image with the CLI, a command template that works without an allow list, and a git identity (ORC-27, cloud-native M4).

## What Changes

- New `src/agent/remote-submit.ts`: before a remote submit, the dirty check of the clone by the rule of a local seal (`dirtyFiles` outside `.orchestrator/`), `git push --force origin HEAD:refs/heads/<branch>` bounded at 60 s (through `git` with `timeoutMs`, no prompt), then the full sha of `HEAD`. Answers the sha or the refusal: 409 `dirtyWorktree`, 503 `pushFailed`, 500 `gitFailed`.
- `src/agent/mcp-shim.ts`: remote mode when `ORCH_ACCESS=remote`, which needs `ORCH_WORKTREE` and `ORCH_BRANCH` (exit 1 naming the missing one). A `report` with kind `submit` runs the three steps and forwards the body with `sealedSha`; a refusal sends nothing. The input schema gains no `sealedSha`. The tool's description and `USAGE` name the remote mode. Without `ORCH_ACCESS=remote` the shim is as at c5471a4.
- `src/worker/loop.ts`, `writeLaunchFiles` only: the shim's `env` in `.orchestrator/mcp.json` carries `ORCH_ACCESS=remote`, `ORCH_WORKTREE` (the clone) and `ORCH_BRANCH` (the claim's branch), through `shimEnv`'s `extra`.
- `src/brief/compose.ts`: the remote Submit line names the `orchestrator` MCP server's `report` tool as the one that pushes the branch and names the pushed commit, tells an agent that calls the API itself to push and send `sealedSha`, and says the orchestrator reads the work from `origin`. Local briefs and the fallback line are unchanged.
- New `deploy/worker-claude/Dockerfile`: `ARG PROJECT_BASE=orchestrator:dev`, one stage `FROM ${PROJECT_BASE}`, the Claude Code CLI installed as root at `CLAUDE_CODE_VERSION`, back to `node`, `DISABLE_AUTOUPDATER=1`, the git identity `orchestrator-worker <worker@orchestrator.local>`, `ORCH_WORKER_COMMAND` set to the Claude template with `--dangerously-skip-permissions` and no `{allowedTools}`, `CMD ["orchestrator-worker"]`, no key. Not built by this change (ORC-31 builds it and pins the version).
- `deploy/README.md`: a section "Claude worker image"; "The workers" says the shim's `report` tool pushes the branch and names `sealedSha`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-protocol`: MODIFIED "MCP façade" (remote mode) and "Standalone brief" (the remote Submit sentence and its scenario).
- `worker-pool`: MODIFIED "Clone cache" (three more variables in `mcp.json`).
- `cluster-runtime`: ADDED "Claude worker image".

`worker-pool` "Agent command" and `cluster-runtime` "Daemon image" are not changed.

## Impact

- New `src/agent/remote-submit.ts`, `deploy/worker-claude/Dockerfile`, `test/slice/shim-remote.test.ts`, `test/slice/worker-shim.test.ts`, `test/agents/mcp-report-agent.ts`, `test/host/worker-image.test.ts`.
- `src/agent/mcp-shim.ts`, `src/worker/loop.ts` (`writeLaunchFiles`), `src/brief/compose.ts`, `test/loop/remote-brief.test.ts`, `deploy/README.md`.
- The daemon (`src/loop/**`, `src/operator/**`), the daemon's `Dockerfile` and the manifests are unchanged.
- Not proven here: that the image builds and that `claude` starts in it (ORC-31). The fallback relay still pushes without force and without a dirty check. The loop's claim names no runner kind, so a worker of this image also claims a launch prepared for `codex` or `opencode`.
