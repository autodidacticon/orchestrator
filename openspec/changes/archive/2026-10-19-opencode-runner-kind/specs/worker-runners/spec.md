## MODIFIED Requirements

### Requirement: Runner kinds and defaults
The configuration SHALL carry `runner.kind`, one of `claude-code`, `codex`, and `opencode`, defaulting to `claude-code`, and one block per kind: `runner.claude`, `runner.codex`, and `runner.opencode`. `runner.kind` SHALL resolve through the configuration layers as the key `runnerKind`: an argument (a `start` argument, a `--set` flag, or a runtime override) beats the file, which beats the default; it SHALL NOT be detected, pinned, or start-only, and a change SHALL apply to launches prepared afterwards. A value outside the kinds SHALL be refused at configuration time naming `runner.kind` in the file and `runnerKind` as an argument. Each kind SHALL have its own default model: `claude-opus-5-5` for `claude-code`, `gpt-6-astra` for `codex`, and `anthropic/claude-opus-5-5` for `opencode` (the Claude Code default reached through the user's OpenCode Anthropic login); all default to effort `medium`. `runner.codex` SHALL carry `command` (unset by default, so the runner's built-in template applies), `model`, `effort`, `sandbox` (`read-only`, `workspace-write`, or `danger-full-access`, default `workspace-write`), `commit` (`agent` or `daemon`, unset by default), `networkAccess` (unset by default), `ignoreUserConfig` (default true), `ephemeral` (default true), `mcpApproval`, `toolTimeoutSec`, and `startupTimeoutSec`; the semantics of the policy keys belong to the Codex runner. `runner.opencode` SHALL carry `command` (unset by default), `model` (a `provider/model` id), `effort`, `commit` (`agent` or `daemon`, default `agent`), `permission` (`derived` or `allow`, default `derived`), `dataDir` (`shared` or `launch`, default `shared`), `ignoreUserConfig` (default false), `pure` (default true), and `snapshots` (default false); the semantics of the policy keys belong to the OpenCode runner. The run default `model` and `effort` SHALL be those of the kind in force, so a run under `codex` never resolves a Claude model. Every operator surface SHALL expose the kind and the per-kind keys. These are `orchestrator-ctl start --set runnerKind=... --set codex.<leaf>=...`, `orchestrator-ctl config --runner-kind --sandbox --commit`, the MCP `start` and `configure` tools (`runnerKind`, `codex`, `sandbox`, `commit`), and `PUT /v1/config`. Each surface that names a default SHALL name both kinds' defaults.

#### Scenario: Claude Code by default
- **WHEN** the daemon starts with no file and no overrides
- **THEN** `config.runnerKind` is `{ value: "claude-code", source: "default" }` and `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`

#### Scenario: The file selects Codex
- **WHEN** `orchestrator.yaml` sets `runner.kind: codex` and nothing else under `runner`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "file" }`, `config.model` is `{ value: "gpt-6-astra", source: "default", applied: true }`, `config.effort` is `{ value: "medium", source: "default", applied: true }`, and `config.codex.sandbox` is `{ value: "workspace-write", source: "default" }`

#### Scenario: The file sets the Codex model
- **WHEN** the file sets `runner.kind: codex` and `runner.codex.model: gpt-6-pro`
- **THEN** `config.model` is `{ value: "gpt-6-pro", source: "file", applied: true }`

#### Scenario: The file selects OpenCode
- **WHEN** `orchestrator.yaml` sets `runner.kind: opencode` and nothing else under `runner`
- **THEN** `config.model` is `{ value: "anthropic/claude-opus-5-5", source: "default", applied: true }`, and `config.opencode` carries `commit` `{ value: "agent", source: "default" }`, `permission` `{ value: "derived", source: "default" }`, and `dataDir` `{ value: "shared", source: "default" }`

#### Scenario: Selected at runtime
- **WHEN** `PUT /v1/config` carries `runnerKind: "codex"` on a running daemon
- **THEN** the response is 200, `config.json` shows `runnerKind` `{ value: "codex", source: "argument" }` with the `codex` leaves, and launches prepared afterwards resolve the Codex model

#### Scenario: Selected from the operator surfaces
- **WHEN** the operator runs `orchestrator-ctl config --runner-kind codex`, or calls the MCP `configure` tool with `runnerKind: "codex"`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "argument" }` in either case

#### Scenario: Unknown kind refused
- **WHEN** `PUT /v1/config` carries `runnerKind: "cursor"`, or the file sets `runner.kind: cursor`
- **THEN** the route answers 400 naming `runnerKind`, and the file fails to load naming `runner.kind`

#### Scenario: Each kind keeps its own model
- **WHEN** the operator sets `runnerKind` to `codex` and `model` to `gpt-6-astra` in one patch, then clears `runnerKind`
- **THEN** under `codex` the model is `gpt-6-astra` with source `argument`, and after the clear the model is the Claude Code default with source `default`

### Requirement: Per-kind effort sets
Each runner kind SHALL accept its own set of effort levels: `claude-code` accepts `low`, `medium`, `high`, `xhigh`, and `max`; `codex` accepts those and `ultra`; `opencode` accepts the `claude-code` set and passes the level through as `--variant`, which variants a model lists being the CLI's to decide. The set SHALL be a superset check: a model of the kind may accept fewer levels, and the CLI remains the final validator. `runner.claude.effort`, `runner.codex.effort`, and `runner.opencode.effort` in the file, and an `effort` argument, SHALL be validated against the set of their kind, and a refusal SHALL name `effort` and the kind. A task's `effort` selector, in the graph file or from an import label, SHALL be validated against the union of every kind's set, since the kind a task runs under is decided when its launch is prepared. Each kind SHALL define the level it runs at in place of one it lacks (`ultra` as `max` for `claude-code` and for `opencode`); the moment that mapping applies belongs to launch preparation.

#### Scenario: Ultra refused for Claude Code
- **WHEN** the kind in force is `claude-code` and `PUT /v1/config` carries `effort: "ultra"`
- **THEN** the response is 400 naming `effort` and `claude-code`, and nothing changes

#### Scenario: Ultra accepted for Codex
- **WHEN** the kind in force is `codex` and `PUT /v1/config` carries `effort: "ultra"`
- **THEN** the response is 200 and `config.effort` is `{ value: "ultra", source: "argument", applied: true }`

#### Scenario: The file is checked per kind
- **WHEN** the file sets `runner.claude.effort: ultra`
- **THEN** the file fails to load; `runner.codex.effort: ultra` loads

#### Scenario: Ultra prepared as max for OpenCode
- **WHEN** the kind in force is `opencode` and a task declares `effort: ultra`
- **THEN** its launch is prepared with `effort: max` and `launch.created` carries `effortRequested: ultra`

#### Scenario: Task selectors use the union
- **WHEN** a node declares `effort: ultra`, or an imported issue carries the label `effort:ultra`
- **THEN** the node's payload carries `effort: ultra`; `effort: huge` still fails graph validation naming the node and `effort`, and the label `effort:huge` is ignored

### Requirement: Sandbox and commit policy
The configuration SHALL carry `runner.codex.sandbox` with one of `read-only`, `workspace-write`, or `danger-full-access`, defaulting to `workspace-write`. Each runner kind SHALL carry a commit policy, `runner.<kind>.commit`, with one of `agent` (the agent commits before it submits) or `daemon` (the daemon commits what the agent left when it submits). `runner.claude.commit` SHALL default to `agent`. OpenCode has no sandbox, only per-tool permission rules, so nothing stands between its agent and git: `runner.opencode.commit` SHALL default to `agent` and SHALL NOT be derived. When `runner.codex.commit` is unset it SHALL be derived from the sandbox in force: `daemon`, or `agent` when the sandbox is `danger-full-access`. The reason is that under `workspace-write` Codex cannot run `git add` or `git commit` in a linked worktree: the index lock under `<repo>/.git/worktrees/<wt>/` is refused with `Operation not permitted`, and Codex keeps `.git` and the resolved gitdir read-only even inside writable roots. `codex.sandbox`, `codex.commit`, `claude.commit`, and `opencode.commit` SHALL be accepted as runtime overrides that apply to launches prepared afterwards. A derived value moves with a sandbox override, and an explicit `commit` wins over the derivation. The policy SHALL be resolved from the launch's runner kind when the launch is prepared, recorded on the launch row as `commitPolicy` and in `launch.created`, and passed to the brief input with the sandbox of a `codex` launch. A row without a policy SHALL be treated as `agent`. Under `daemon` the daemon SHALL set `ORCH_COMMIT_POLICY=daemon` in the agent's environment and in the MCP façade's.

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
