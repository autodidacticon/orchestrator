## Why

The agent protocol makes the agent commit: a dirty worktree at submit is refused with 409, and a clean worktree with no commits fails `emptySubmission`. Under Codex's documented default sandbox, `workspace-write`, the agent cannot commit in a linked worktree. Probed on 2026-10-18 with codex-cli 0.163.0, `git add` and `git commit` fail with `fatal: Unable to create '<repo>/.git/worktrees/<wt>/index.lock': Operation not permitted`. Neither `--add-dir` nor `sandbox_workspace_write.writable_roots` helps, because Codex keeps `.git`, the resolved gitdir, and `.codex` read-only inside writable roots. So a Codex agent submits dirty, gets 409, is told to commit, cannot, and loops until the lease or the time budget runs out.

## What Changes

- `runner.codex.sandbox: read-only | workspace-write | danger-full-access` (default `workspace-write`, the mode that was probed and is safe).
- A per-kind `runner.<kind>.commit: agent | daemon`. `runner.claude.commit` defaults to `agent`. `runner.codex.commit` is derived when unset: `daemon`, or `agent` when `sandbox` is `danger-full-access`. `codex.sandbox`, `codex.commit`, and `claude.commit` can be overridden at runtime; an override applies to launches prepared afterwards.
- The commit policy is resolved per launch from its runner kind at preparation. It is recorded on the row as `commitPolicy` and in `launch.created`. A row without it reads as `agent`.
- Under `daemon`, sealing a submit (posted or from the fallback file) commits a dirty worktree, minus `.orchestrator/`, as `orchestrator` with `--no-verify`. The report summary is the commit message and the new head is `sealedSha`. `agent.report` (and `agent.fallback`) record `committedByOrchestrator: true`. A clean worktree is not committed, so `emptySubmission` still applies. Under `agent`, nothing changes.
- The MCP shim reads `ORCH_COMMIT_POLICY` (unset means `agent`). It states the committed, clean worktree requirement in the `report` tool's description only under `agent`. The daemon sets the variable in the agent environment, and the Claude runner forwards it into `mcp.json`, only for a `daemon` launch.
- The brief input carries `runner.commitPolicy`, and `runner.sandbox` for codex launches. The brief sentences keyed to them belong to the brief-text change (ORC-48).
- The stuck nudge no longer tells the agent to commit: "Commit or report what you have, or ask a question."

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `worker-runners`: ADDED `Sandbox and commit policy`.
- `agent-protocol`: `Submission sealing`, `Fallback file`, `Declared no-op`, `Standalone brief`, `MCP façade` are qualified by the launch's commit policy.

## Impact

- Code: `src/runner/selection.ts` (`COMMIT_POLICIES`, `CODEX_SANDBOXES`, `defaultCodexCommit`), `src/config.ts`, `src/runs/resolve.ts` (`claude.commit` leaf and override, derived `codex.commit`), `src/state/store.ts` (`Launch.commitPolicy`, `commitPolicyOf`), `src/launch/launch.ts`, `src/loop/core.ts`, `src/loop/orchestrator.ts` (`commitPolicyFor`, `sealSubmission`, `sealFallback`), `src/loop/tick.ts`, `src/launch/recovery.ts`, `src/workspace/{workspace,git-workspace,fake}.ts` (`seal(launch, { autoCommit })`), `src/agent/mcp-shim.ts`, `src/runner/claude-code.ts`, `src/health/stuck.ts`.
- Behaviour: unchanged for a claude-code run with the default `agent` policy, apart from the new fields and the stuck text.
