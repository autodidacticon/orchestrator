## ADDED Requirements

### Requirement: OpenCode e2e contended-death counter rule
The opt-in OpenCode end-to-end test SHALL check the counter rule of task-lifecycle "Retry and exhaustion" from `health.contendedRetries`, not from the events' own flags. A task's deaths with reason `startupContended` up to that allowance SHALL record `charged: false` and later ones `charged: true`. The task's attempts SHALL equal its launches minus one minus the uncharged deaths so counted.

#### Scenario: Charged death within the allowance
- **WHEN** the check, run by a unit test without opencode, is given a task whose first `startupContended` death records `charged: true` with the allowance at 2, and attempts consistent with that flag
- **THEN** the check fails

#### Scenario: Deaths as the rule says
- **WHEN** a task's first two `startupContended` deaths record `charged: false` and a third `charged: true`, with the allowance at 2, four launches and one attempt
- **THEN** the check passes

## MODIFIED Requirements

### Requirement: Sandbox and commit policy
The configuration SHALL carry `runner.codex.sandbox` with one of `read-only`, `workspace-write`, or `danger-full-access`, defaulting to `workspace-write`. Each runner kind SHALL carry a commit policy, `runner.<kind>.commit`, with one of `agent` (the agent commits before it submits) or `daemon` (the daemon commits what the agent left when it submits). `runner.claude.commit` SHALL default to `agent`. OpenCode has no sandbox, only per-tool permission rules, so nothing stands between its agent and git: `runner.opencode.commit` SHALL default to `agent` and SHALL NOT be derived. When `runner.codex.commit` is unset it SHALL be derived from the sandbox in force: `daemon`, or `agent` when the sandbox is `danger-full-access`. The reason is that under `workspace-write` Codex cannot run `git add` or `git commit` in a linked worktree: the index lock under `<repo>/.git/worktrees/<wt>/` is refused with `Operation not permitted`, and Codex keeps `.git` and the resolved gitdir read-only even inside writable roots. `codex.sandbox`, `codex.commit`, `claude.commit`, and `opencode.commit` SHALL be accepted as runtime overrides that apply to launches prepared afterwards. A derived value moves with a sandbox override, and an explicit `commit` wins over the derivation. The policy SHALL be resolved from the launch's runner kind when the launch is prepared, recorded on the launch row as `commitPolicy` and in `launch.created`, and passed to the brief input with the sandbox of a `codex` launch and the permission mode (and derived bash patterns) of an `opencode` launch. An `opencode` launch has no sandbox in its brief input. A row without a policy SHALL be treated as `agent`. Under `daemon` the daemon SHALL set `ORCH_COMMIT_POLICY=daemon` in the agent's environment and in the MCP façade's.

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

#### Scenario: OpenCode commits as the agent by default
- **WHEN** an `opencode` launch is prepared and `runner.opencode.commit` is unset
- **THEN** the policy is `agent`, `ORCH_COMMIT_POLICY` is not set, the brief tells the agent to commit and resubmit, and the daemon does not commit at submit

#### Scenario: Daemon commits chosen for OpenCode
- **WHEN** `runner.opencode.commit` is `daemon`
- **THEN** the launch carries `commitPolicy: daemon`, the agent environment sets `ORCH_COMMIT_POLICY=daemon` (so the shim's report tool takes its daemon-commits wording), and the daemon commits a dirty worktree when it accepts the submit

#### Scenario: Daemon commits an OpenCode submit in the real-git slice
- **WHEN** an `opencode` launch under `runner.opencode.commit: daemon` runs through the OpenCode runner and its default template, with a fake `opencode` on PATH that submits a dirty worktree
- **THEN** the task reaches `done`, the launch branch head is a commit by `orchestrator` holding only the agent's file with the report summary as its message, `sealedSha` is that head, and `agent.report` carries `committedByOrchestrator: true`
