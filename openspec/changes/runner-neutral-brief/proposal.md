## Why

Most of the brief is runner-neutral, but two parts assume a Claude Code agent that commits. The workspace paragraph about Bash rules is Claude-specific, and a Codex brief has no sandbox guidance: with approvals disabled, a command the sandbox refuses fails with `Operation not permitted` and the agent is never told to stop retrying and ask. The git-write sentences (commit and resubmit, you may rebase, rebase the conflicted branch, merge or cherry-pick and squash the work-in-progress commit, commit the revision delta) are impossible under `workspace-write`, where `git commit` in a linked worktree fails. Under the `daemon` commit policy they also contradict what the orchestrator does.

## What Changes

- `BriefJson` carries `runner` (`kind`, `commitPolicy`, and `sandbox` for codex) when the brief input has one. `BriefInput.runner` becomes optional; without it the brief is the Claude Code text under the `agent` policy, unchanged.
- The Bash-rules paragraph is emitted only for a `claude-code` launch with an allow list (as before, the list only reaches claude-code launches the daemon spawns).
- A `codex` launch gets a sandbox paragraph naming the mode: refused commands fail with `Operation not permitted` and are not approved at runtime; do not retry, ask with a `needsAccess` question naming the command; the operator can run it or change `runner.codex.sandbox` for the next launch.
- Under the `daemon` commit policy: the definition of done says to leave changes in the worktree, committed or not, for the orchestrator to commit at accept; the integration-branch prohibition stays, and the rebase allowance is replaced by "the orchestrator rebases your branch onto the integration head at verification"; the conflict, interrupted, and revision texts tell the agent to inspect the prior branch with `git show`/`git diff` and reapply its changes as file edits. Under `agent` the five sentences are unchanged.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `agent-protocol`: `Standalone brief`, `Check command and tool rules in the brief`, and `Inbox notices for health` are qualified by the launch's runner kind and commit policy.
- `worker-runners`: `Sandbox and commit policy` gains the brief-text clauses. This delta modifies the requirement added by `sandbox-and-commit-policy`, so that change is archived first.

## Impact

- Code: `src/brief/compose.ts`, `src/workspace/workspace.ts`.
- Behaviour: unchanged for a claude-code launch under the `agent` policy; brief.json gains `runner`.
