## MODIFIED Requirements

### Requirement: Sandbox and commit policy
The configuration SHALL carry `runner.codex.sandbox` with one of `read-only`, `workspace-write`, or `danger-full-access`, defaulting to `workspace-write`. Each runner kind SHALL carry a commit policy, `runner.<kind>.commit`, with one of `agent` (the agent commits before it submits) or `daemon` (the daemon commits what the agent left when it submits). `runner.claude.commit` SHALL default to `agent`. When `runner.codex.commit` is unset it SHALL be derived from the sandbox in force: `daemon`, or `agent` when the sandbox is `danger-full-access`. The reason is that under `workspace-write` Codex cannot run `git add` or `git commit` in a linked worktree: the index lock under `<repo>/.git/worktrees/<wt>/` is refused with `Operation not permitted`, and Codex keeps `.git` and the resolved gitdir read-only even inside writable roots. `codex.sandbox`, `codex.commit`, and `claude.commit` SHALL be accepted as runtime overrides that apply to launches prepared afterwards. A derived value moves with a sandbox override, and an explicit `commit` wins over the derivation. The policy SHALL be resolved from the launch's runner kind when the launch is prepared, recorded on the launch row as `commitPolicy` and in `launch.created`, and passed to the brief input with the sandbox of a `codex` launch. A row without a policy SHALL be treated as `agent`. Under `daemon` the daemon SHALL set `ORCH_COMMIT_POLICY=daemon` in the agent's environment and in the MCP façade's.

The brief SHALL follow the policy. Under `agent` it SHALL tell the agent to commit all work and resubmit after a 409. It SHALL allow rebasing the launch branch onto the integration head, and tell the agent to rebase a conflicted branch, merge or cherry-pick an interrupted one and squash its work-in-progress commit, and commit a revision delta. Under `daemon` it SHALL tell the agent to leave its changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. It SHALL say the orchestrator rebases the branch at verification, and tell the agent to inspect a prior branch with `git show`/`git diff` and reapply the changes as file edits. Under `daemon` none of the agent-side git-write instructions SHALL appear. A `codex` launch's brief SHALL also name its sandbox mode and tell the agent that a refused command is not approved at runtime and is to be asked for with a `needsAccess` question rather than retried.

#### Scenario: Claude Code commits by default
- **WHEN** a run uses the default configuration
- **THEN** `runner.claude.commit` resolves to `agent` and a claude-code launch is prepared with `commitPolicy: agent`

#### Scenario: Codex under the default sandbox
- **WHEN** a run sets `runner.kind: codex` and sets neither `runner.codex.sandbox` nor `runner.codex.commit`
- **THEN** the sandbox resolves to `workspace-write`, `runner.codex.commit` resolves to `daemon`, and the launch is prepared with `commitPolicy: daemon`

#### Scenario: Codex with full access
- **WHEN** `runner.codex.sandbox` is `danger-full-access` and `runner.codex.commit` is unset
- **THEN** `runner.codex.commit` resolves to `agent`

#### Scenario: Daemon commits chosen for Claude Code
- **WHEN** the operator sets `claude.commit: daemon` at runtime
- **THEN** claude-code launches prepared afterwards carry `commitPolicy: daemon` and launches already prepared keep theirs

#### Scenario: Codex brief under each policy
- **WHEN** a brief is composed for a `codex` launch under `daemon` with `workspace-write`, and another under `agent` with `danger-full-access`
- **THEN** both name their sandbox; the first says the orchestrator commits uncommitted changes and contains none of "commit and resubmit", "You may rebase", "Rebase that branch or start over", "squash the work-in-progress commit", or "commit the delta"; the second contains all five
