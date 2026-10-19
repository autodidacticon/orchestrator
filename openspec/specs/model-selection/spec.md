# Model Selection Specification

## Purpose
How the worker model and effort level are decided for a launch: a run default resolved with provenance, a per-task selector in the payload, validation of both, the moment the choice is fixed, and how runners, workers, and operators see it.

## Requirements

### Requirement: Run default model and effort
The configuration SHALL carry a model and an effort per runner kind (see worker-runners "Runner kinds and defaults"): `runner.claude.model`, defaulting to `claude-opus-5-5`, and `runner.claude.effort` for `claude-code`; `runner.codex.model`, defaulting to `gpt-6-astra`, and `runner.codex.effort` for `codex`; `runner.opencode.model`, defaulting to `anthropic/claude-opus-5-5`, and `runner.opencode.effort` for `opencode`; each effort defaulting to `medium`. A model SHALL have its kind's shape: for `claude-code` and `codex` it SHALL match `^[A-Za-z0-9][A-Za-z0-9._:-]*$`; for `opencode` it SHALL be `provider/model`, two names of that shape joined by exactly one `/`, so nothing else reaches the shell template. A file value, a namespaced argument, or a flat argument bound to a kind SHALL be refused naming the key when it lacks the kind's shape; a flat `model` not yet bound to a kind SHALL take either shape and apply only to a kind whose shape it has. The run default SHALL be the model and effort of the kind in force, resolved through the configuration layers as the flat keys `model` and `effort`: an argument (a `start` argument, a `--set` flag, or a runtime override) beats the file, which beats the default, and the resolved record SHALL carry the source of each. An argument MAY name a kind's key directly (`claude.model`, `codex.effort`); a flat `model` or `effort` argument SHALL bind to the kind in force when it is written, or to a `runnerKind` in the same patch, so changing the kind later does not carry one kind's model to another. Neither key SHALL be detected or pinned, and neither SHALL be start-only.

#### Scenario: Defaults without a file
- **WHEN** the daemon starts in a repository with no `orchestrator.yaml` and no overrides
- **THEN** `config.model` is `{ value: "claude-opus-5-5", source: "default" }` and `config.effort` is `{ value: "medium", source: "default" }`

#### Scenario: File sets the model and an argument sets the effort
- **WHEN** `orchestrator.yaml` sets `runner.claude.model: opus` and the daemon starts with `--set effort=high`
- **THEN** `config.model` is `{ value: "opus", source: "file" }` and `config.effort` is `{ value: "high", source: "argument" }`

#### Scenario: Codex default model
- **WHEN** the file sets `runner.kind: codex` and no model
- **THEN** `config.model` is `{ value: "gpt-6-astra", source: "default" }`, not a Claude model

#### Scenario: OpenCode model shape
- **WHEN** the kind in force is `opencode` and `PUT /v1/config` carries `model: "opencode/big-pickle"`, then the kind in force is `claude-code` and a patch carries the same model
- **THEN** the first is 200 and `config.model` is `{ value: "opencode/big-pickle", source: "argument" }`; the second is 400 naming `model`; `opencode/a/b`, `/x`, `x/`, and `a b/c` are refused for `opencode`

#### Scenario: Stored flat override read as Claude Code's
- **WHEN** a run's stored override document, written before runner kinds, holds `{ model: "opus" }`
- **THEN** it is read as `claude.model`, and under `claude-code` `config.model` is `{ value: "opus", source: "argument" }`

### Requirement: Task selectors
A task MAY carry `runner`, `model`, and `effort` in its payload. A present `runner` SHALL be one of the runner kinds (`claude-code`, `codex`, `opencode`). A present `effort` SHALL be one of the levels some runner kind accepts (`low`, `medium`, `high`, `xhigh`, `max`, and `ultra` for `codex`; see worker-runners "Per-kind effort sets"); whether the chosen kind accepts it is checked when the launch is prepared, not at load. A present `model` SHALL have the shape of the task's own `runner` when it declares one, and otherwise the shape of some kind (see "Run default model and effort"): a `provider/model` id is accepted at load and bound when the launch is prepared, where a kind other than `opencode` does not take it and the launch runs that kind's default model. An import `model:` label follows the same rule, and a label refused beside a `runner:` label of another kind is listed as ignored. A present value of any other shape SHALL fail graph validation naming the node and the key. A task without a selector SHALL use the run default for that key; for `model` and `effort` that is the default of the kind the launch runs under.

#### Scenario: Selectors load from the graph file
- **WHEN** a node declares `model: claude-sonnet-5-5` and `effort: low`
- **THEN** the loaded node's payload carries both values

#### Scenario: Runner selector loads from the graph file
- **WHEN** a node declares `runner: codex`
- **THEN** the loaded node's payload carries `runner: codex`

#### Scenario: Codex-only level loads
- **WHEN** a node declares `effort: ultra`
- **THEN** the loaded node's payload carries `effort: ultra`

#### Scenario: Invalid effort refused at load
- **WHEN** a node declares `effort: huge`
- **THEN** loading fails and the error names the node and `effort`

#### Scenario: Unknown runner refused at load
- **WHEN** a node declares `runner: bogus`
- **THEN** loading fails and the error names the node and `runner`

#### Scenario: Provider/model selector
- **WHEN** node A declares `model: opencode/big-pickle`, node O declares it with `runner: opencode`, and node C declares it with `runner: codex`, on a run whose kind is `claude-code`
- **THEN** loading fails naming C and `model`; without C, A's launch runs `claude-code` with `claude-opus-5-5` and O's runs `opencode` with `opencode/big-pickle`

#### Scenario: Unsafe model refused at load
- **WHEN** a node declares `model: "opus; rm -rf /"`
- **THEN** loading fails and the error names the node and `model`

### Requirement: Resolution fixed at preparation
When a launch is prepared the daemon SHALL set the launch's `runner` to the task's `runner` when present, else the runner kind in force, its `model` to the task's `model` when present and of that kind's shape, else the default model of that kind (never another kind's), and its `effort` to the task's `effort` when present, else the default effort of that kind. The effort SHALL be checked against the chosen kind's effort set before the kind's fallback applies: a level the kind accepts is kept, a level it lacks is replaced by the kind's fallback (`ultra` as `max` for `claude-code` and `opencode`), and the level asked for SHALL then be recorded as `effortRequested`. The daemon SHALL record `runner`, `model`, and `effort`, and `effortRequested` when present, in the `launch.created` event payload. The values SHALL NOT change for that launch afterwards: a later override (of the kind, the model, or the effort) applies to launches prepared after it, and a retry is a new launch that resolves again from the task and the run default in force at that time.

#### Scenario: Task selector wins over the run default
- **WHEN** the run default effort is `medium` and T2 declares `effort: high`
- **THEN** T2's launch has `effort: high` and T1's launch, with no selector, has `effort: medium`

#### Scenario: Override applies to later launches only
- **WHEN** T1's launch was prepared under model `claude-opus-5-5`, the operator sets `model` to `claude-sonnet-5-5`, and T2 is prepared afterwards
- **THEN** T1's launch still has `claude-opus-5-5` and T2's launch has `claude-sonnet-5-5`

#### Scenario: Retry resolves again
- **WHEN** T1's first launch failed under effort `medium` and the operator set `effort` to `high` before the retry was prepared
- **THEN** the retry launch has `effort: high`

#### Scenario: Kind recorded on the launch
- **WHEN** a launch is prepared under the default configuration
- **THEN** the launch row and its `launch.created` payload carry `runner: "claude-code"`, and under run kind `codex` they carry `runner: "codex"`

#### Scenario: Kind override applies to later launches only
- **WHEN** T1's launch was prepared under `claude-code`, the operator sets `runnerKind` to `codex`, and T3 is prepared afterwards
- **THEN** T1's launch still has `runner: "claude-code"` and T3's launch has `runner: "codex"`

#### Scenario: Codex defaults for a task without selectors
- **WHEN** the run kind is `codex` and a task declares neither `model` nor `effort`
- **THEN** its launch has `model: "gpt-6-astra"` and `effort: "medium"`

#### Scenario: Task runner selector wins over the run kind
- **WHEN** the run kind is `claude-code` and a task declares `runner: codex` and no `model` or `effort`
- **THEN** its launch, its `launch.created` payload, its `status.liveLaunches[]` entry, and its claim response carry `runner: "codex"`, `model: "gpt-6-astra"`, and `effort: "medium"`, while a task without a selector in the same run gets `runner: "claude-code"` and `model: "claude-opus-5-5"`

#### Scenario: Ultra falls back under Claude Code
- **WHEN** a task declares `effort: ultra` and the run kind is `claude-code`
- **THEN** its launch has `effort: "max"` and `launch.created` carries `effortRequested: "ultra"`; under `codex` the launch keeps `effort: "ultra"` and no `effortRequested` is recorded

#### Scenario: Effort checked against the task's kind
- **WHEN** the run kind is `claude-code`, task CU declares `runner: codex` and `effort: ultra`, and task K declares `effort: ultra` and no runner
- **THEN** CU's launch keeps `effort: "ultra"` with no `effortRequested`, and K's launch has `effort: "max"` with `effortRequested: "ultra"`

### Requirement: Runners and workers receive the values
The spawn runner SHALL fill `{model}` and `{effort}` in the runner command from the launch at every spawn. The claim response SHALL carry the launch's `runner`, `model`, and `effort`. The brief input of every launch SHALL carry `runner: { kind }`, the kind fixed on the launch. The daemon SHALL NOT validate a model name against any list: a name the CLI rejects fails the launch at spawn, and the failure is recorded by health monitoring like any other dead process.

#### Scenario: Spawned command carries the flags
- **WHEN** a launch with `model: claude-opus-5-5` and `effort: medium` is spawned with the default runner command
- **THEN** the command run contains `--model claude-opus-5-5 --effort medium`

#### Scenario: Claimed launch carries the values
- **WHEN** a worker claims a launch whose task declares `model: claude-sonnet-5-5`
- **THEN** the claim response has `runner: "claude-code"`, `model: "claude-sonnet-5-5"`, and the run default `effort`

#### Scenario: Brief input carries the kind
- **WHEN** a launch prepared under `codex` is briefed
- **THEN** its brief input has `runner: { kind: "codex" }` and no allow list

#### Scenario: Unknown model fails the launch
- **WHEN** a task declares `model: not-a-model` and its launch is spawned
- **THEN** the process exits at once, the launch ends dead, and the task's attempt is recorded as failed with the exit visible in the launch log

### Requirement: Selection visible to operators
`status.liveLaunches[]` SHALL carry each launch's `runner`, `model`, and `effort`. The configuration block in `status`, `config.json`, `GET /v1/config`, and the `start` result SHALL carry `model` and `effort` as `{ value, source, applied }`, where `applied` is whether the runner command in force contains the corresponding slot.

#### Scenario: Live launch shows its selection
- **WHEN** T2 is live with `effort: high`
- **THEN** `status.liveLaunches` has an entry for T2 with `effort: "high"`, its `model`, and its `runner`

#### Scenario: Verbatim runner command marks the keys unapplied
- **WHEN** the file sets `runnerCommand` to a command without `{model}` or `{effort}`
- **THEN** `config.model.applied` and `config.effort.applied` are both false
