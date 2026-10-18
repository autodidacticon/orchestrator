## Context

The protocol assumes the agent commits. `GitWorkspace.seal` refuses any dirty file outside `.orchestrator/`, `handleReport` answers 409 `dirtyWorktree`, and `checkSubmission` fails `emptySubmission` when `sealedSha === baseSha` without `noChanges`. The fallback path seals the same way. The shim, the brief, and the stuck nudge all tell the agent to commit.

Facts from probes on 2026-10-18 (codex-cli 0.163.0):

- Under `-s workspace-write`, `git add` and `git commit` in a linked worktree fail on `<repo>/.git/worktrees/<wt>/index.lock` with `Operation not permitted`. `--add-dir` and `sandbox_workspace_write.writable_roots` do not help, because `.git`, the resolved gitdir, and `.codex` stay read-only inside writable roots.
- `danger-full-access` was not probed.
- The MCP server process is not sandboxed: in probe G it committed in the linked worktree from inside a tool call.
- The Claude runner has no OS sandbox (`--permission-mode acceptEdits`). So `danger-full-access` for Codex matches what the Claude runner already does; it is not a regression.

## Decisions

- **A per-kind `commit` key with a derived Codex default.** `runner.claude.commit` defaults to `agent`. `runner.codex.commit` is unset in the schema, and `resolveLayers` derives it from the resolved sandbox (`defaultCodexCommit`): `daemon` unless the sandbox is `danger-full-access`. A derived value has source `default`. Because the derivation reads the resolved leaf, a runtime `codex.sandbox` override moves the default with it, and an explicit `commit` (from the file or an override) wins. The Claude key exists so the slice harness can exercise `daemon` through `SubprocessRunner` without a Codex runner, and so an operator can choose daemon commits for Claude too.
- **The policy is fixed at preparation.** It is resolved like the runner kind, model, and effort, and recorded on the row as `commitPolicy` and in `launch.created`. `commitPolicyOf(launch)` reads `agent` for an older row, so sealing under the default policy behaves exactly as before.
- **The daemon commits inside `seal`.** `seal(launch, { autoCommit: { message } })` runs the `preserve()` sequence (`git add -A`, `git rm -r --cached .orchestrator`, commit `--no-verify` as `orchestrator`) only when the filtered dirty list is non-empty, and returns HEAD with `committed: true`. A clean worktree commits nothing, so an empty submission is still empty and needs `noChanges`. `preserve()` and `seal` share one helper. The message is the report summary, or a fixed line naming the task when the summary is empty. `Orchestrator.sealSubmission` picks the option from the row. `handleReport`, the dead-launch path in `tick.ts`, and recovery all go through it (the last two via `sealFallback`). `agent.report` and `agent.fallback` record `committedByOrchestrator: true`. Without `autoCommit` the code path is the old one.
- **The verifier is unchanged.** It squashes with `commit-tree` and the `Orchestrator-Task` trailer, so a daemon-authored commit is published like any other.
- **The shim reads `ORCH_COMMIT_POLICY`.** Unset means `agent`, which covers every existing Claude launch and pull worker. `agentEnv` sets it only for a `daemon` launch. `ClaudeCodeRunner` forwards it into the explicit `mcp.json` env block, which otherwise passes only named variables. ORC-47's `shimEnv` helper does not exist on this base; when it lands, it should carry the variable through its `extra` extension point.
- **The brief text is ORC-48's.** This change only passes `runner.commitPolicy` (and `runner.sandbox` for codex) through `briefInput`.

## Alternatives

- **`danger-full-access` with `commit: agent`.** This matches the Claude runner, which has no OS sandbox at all, and keeps the agent's commit structure and its ability to rebase on `baseMoved`. We expect `git commit` to work in a linked worktree under it, but it was not probed; the end-to-end issue may probe it once. It stays an explicit, configurable choice: setting `runner.codex.sandbox: danger-full-access` derives `commit: agent`.
- **A commit tool in the shim (rejected).** The unsandboxed MCP server can commit (probe G), but a shim-side commit tool would break the agent protocol's "Agent operations", which are exactly five. It would also put git in the agent's process tree.

## Risks / Trade-offs

- Under `daemon`, the agent's commit structure and authorship are lost. The verifier squashes them anyway.
- Under `daemon` with `workspace-write`, the agent cannot rebase on `baseMoved`. The verifier rebases at verification, and a conflict there already becomes a retry with the conflict as context.
- A release with `keep` gives the next agent a branch it can read but cannot rebase under `workspace-write`.
- The `.orchestrator/` guard (`rm --cached`) must stay correct for repositories that track that directory. It is the guard `preserve()` already relies on.
- A pull worker gets no `ORCH_COMMIT_POLICY` from this change. The claim response does not carry the policy yet, so a pull worker's shim reads `agent`. That is correct for the claude-code default.
