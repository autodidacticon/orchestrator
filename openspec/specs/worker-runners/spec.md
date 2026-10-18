# Worker Runners Specification

## Purpose
The agent CLIs a launch can run under: the runner kinds, how a run selects one, each kind's configuration block and defaults, and the effort levels each kind accepts. The Codex runner itself (its command, sandbox, and commit policy) and how a launch is prepared under a kind are specified where they are built; this capability owns the kinds and their configuration.

## Requirements

### Requirement: Runner kinds and defaults
The configuration SHALL carry `runner.kind`, one of `claude-code` and `codex`, defaulting to `claude-code`, and one block per kind: `runner.claude` and `runner.codex`. `runner.kind` SHALL resolve through the configuration layers as the key `runnerKind`: an argument (a `start` argument, a `--set` flag, or a runtime override) beats the file, which beats the default; it SHALL NOT be detected, pinned, or start-only, and a change SHALL apply to launches prepared afterwards. A value outside the kinds SHALL be refused at configuration time naming `runner.kind` in the file and `runnerKind` as an argument. Each kind SHALL have its own default model: `claude-opus-5-5` for `claude-code` and `gpt-6-astra` for `codex`; both default to effort `medium`. `runner.codex` SHALL carry `command` (unset by default, so the runner's built-in template applies), `model`, `effort`, `sandbox` (`read-only`, `workspace-write`, or `danger-full-access`, default `workspace-write`), `commit` (`agent` or `daemon`, unset by default), `networkAccess` (unset by default), `ignoreUserConfig` (default true), `ephemeral` (default true), `mcpApproval`, `toolTimeoutSec`, and `startupTimeoutSec`; the semantics of the policy keys belong to the Codex runner. The run default `model` and `effort` SHALL be those of the kind in force, so a run under `codex` never resolves a Claude model.

#### Scenario: Claude Code by default
- **WHEN** the daemon starts with no file and no overrides
- **THEN** `config.runnerKind` is `{ value: "claude-code", source: "default" }` and `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`

#### Scenario: The file selects Codex
- **WHEN** `orchestrator.yaml` sets `runner.kind: codex` and nothing else under `runner`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "file" }`, `config.model` is `{ value: "gpt-6-astra", source: "default", applied: true }`, `config.effort` is `{ value: "medium", source: "default", applied: true }`, and `config.codex.sandbox` is `{ value: "workspace-write", source: "default" }`

#### Scenario: The file sets the Codex model
- **WHEN** the file sets `runner.kind: codex` and `runner.codex.model: gpt-6-pro`
- **THEN** `config.model` is `{ value: "gpt-6-pro", source: "file", applied: true }`

#### Scenario: Selected at runtime
- **WHEN** `PUT /v1/config` carries `runnerKind: "codex"` on a running daemon
- **THEN** the response is 200, `config.json` shows `runnerKind` `{ value: "codex", source: "argument" }` with the `codex` leaves, and launches prepared afterwards resolve the Codex model

#### Scenario: Unknown kind refused
- **WHEN** `PUT /v1/config` carries `runnerKind: "cursor"`, or the file sets `runner.kind: cursor`
- **THEN** the route answers 400 naming `runnerKind`, and the file fails to load naming `runner.kind`

#### Scenario: Each kind keeps its own model
- **WHEN** the operator sets `runnerKind` to `codex` and `model` to `gpt-6-astra` in one patch, then clears `runnerKind`
- **THEN** under `codex` the model is `gpt-6-astra` with source `argument`, and after the clear the model is the Claude Code default with source `default`

### Requirement: Per-kind effort sets
Each runner kind SHALL accept its own set of effort levels: `claude-code` accepts `low`, `medium`, `high`, `xhigh`, and `max`; `codex` accepts those and `ultra`. The set SHALL be a superset check: a model of the kind may accept fewer levels, and the CLI remains the final validator. `runner.claude.effort` and `runner.codex.effort` in the file, and an `effort` argument, SHALL be validated against the set of their kind, and a refusal SHALL name `effort` and the kind. A task's `effort` selector, in the graph file or from an import label, SHALL be validated against the union of every kind's set, since the kind a task runs under is decided when its launch is prepared. Each kind SHALL define the level it runs at in place of one it lacks (`ultra` as `max` for `claude-code`); the moment that mapping applies belongs to launch preparation.

#### Scenario: Ultra refused for Claude Code
- **WHEN** the kind in force is `claude-code` and `PUT /v1/config` carries `effort: "ultra"`
- **THEN** the response is 400 naming `effort` and `claude-code`, and nothing changes

#### Scenario: Ultra accepted for Codex
- **WHEN** the kind in force is `codex` and `PUT /v1/config` carries `effort: "ultra"`
- **THEN** the response is 200 and `config.effort` is `{ value: "ultra", source: "argument", applied: true }`

#### Scenario: The file is checked per kind
- **WHEN** the file sets `runner.claude.effort: ultra`
- **THEN** the file fails to load; `runner.codex.effort: ultra` loads

#### Scenario: Task selectors use the union
- **WHEN** a node declares `effort: ultra`, or an imported issue carries the label `effort:ultra`
- **THEN** the node's payload carries `effort: ultra`; `effort: huge` still fails graph validation naming the node and `effort`, and the label `effort:huge` is ignored

### Requirement: Runner dispatch by launch kind
The daemon SHALL hold one agent runner per runner kind behind a single dispatching runner, and SHALL route `spawn`, `alive`, `liveness`, `reap`, and `readUsage` for a launch to the runner of the kind fixed on its row, so a launch observed after a restart reaches the runner and the usage parser it was prepared for. A row without a kind SHALL be treated as `claude-code`. Killing by launch id, where only the id is known, SHALL be asked of every registered runner. A launch whose kind has no registered runner SHALL fail at spawn with an error naming the kind; its liveness SHALL be `unknown` and it SHALL have no usage. The allow list SHALL be given only to the brief of a `claude-code` launch. Because the kind on the row comes from the task's `runner` selector when it has one (see model-selection "Task selectors"), one run MAY hold launches of both kinds at once.

#### Scenario: Calls follow the row
- **WHEN** a `claude-code` launch and a `codex` launch are spawned, observed, reaped, and their usage read
- **THEN** each call reaches the runner of the launch's own kind and never the other

#### Scenario: Row without a kind
- **WHEN** a launch row written before the kind was recorded is spawned or its usage read
- **THEN** the `claude-code` runner handles it

#### Scenario: Usage per kind
- **WHEN** a `claude-code` launch submits and a `codex` launch exits in the same run
- **THEN** each launch row records the usage its own kind's runner reads

#### Scenario: Kill by id reaches every runner
- **WHEN** recovery kills a launch by id
- **THEN** every registered runner is asked to kill processes of that id

#### Scenario: No runner for the kind
- **WHEN** a `codex` launch is spawned while no `codex` runner is registered
- **THEN** the spawn fails with an error naming `codex`

#### Scenario: Task-level selector mixes fleets
- **WHEN** the run kind is `claude-code`, a run template has `{allowedTools}`, task C declares `runner: codex`, and task P declares no runner
- **THEN** C's launch is spawned by the `codex` runner with a brief input carrying `runner.kind: "codex"` and no allow list, and P's launch is spawned by the `claude-code` runner with the allow list

### Requirement: Sandbox and commit policy
The configuration SHALL carry `runner.codex.sandbox` with one of `read-only`, `workspace-write`, or `danger-full-access`, defaulting to `workspace-write`. Each runner kind SHALL carry a commit policy, `runner.<kind>.commit`, with one of `agent` (the agent commits before it submits) or `daemon` (the daemon commits what the agent left when it submits). `runner.claude.commit` SHALL default to `agent`. When `runner.codex.commit` is unset it SHALL be derived from the sandbox in force: `daemon`, or `agent` when the sandbox is `danger-full-access`. The reason is that under `workspace-write` Codex cannot run `git add` or `git commit` in a linked worktree: the index lock under `<repo>/.git/worktrees/<wt>/` is refused with `Operation not permitted`, and Codex keeps `.git` and the resolved gitdir read-only even inside writable roots. `codex.sandbox`, `codex.commit`, and `claude.commit` SHALL be accepted as runtime overrides that apply to launches prepared afterwards. A derived value moves with a sandbox override, and an explicit `commit` wins over the derivation. The policy SHALL be resolved from the launch's runner kind when the launch is prepared, recorded on the launch row as `commitPolicy` and in `launch.created`, and passed to the brief input with the sandbox of a `codex` launch. A row without a policy SHALL be treated as `agent`. Under `daemon` the daemon SHALL set `ORCH_COMMIT_POLICY=daemon` in the agent's environment and in the MCP façade's.

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
