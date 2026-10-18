# Model Selection Specification

## Purpose
How the worker model and effort level are decided for a launch: a run default resolved with provenance, a per-task selector in the payload, validation of both, the moment the choice is fixed, and how runners, workers, and operators see it.

## Requirements

### Requirement: Run default model and effort
The configuration SHALL carry a model and an effort per runner kind (see worker-runners "Runner kinds and defaults"): `runner.claude.model`, defaulting to `claude-opus-5-5`, and `runner.claude.effort` for `claude-code`; `runner.codex.model`, defaulting to `gpt-6-astra`, and `runner.codex.effort` for `codex`; each effort defaulting to `medium`. The run default SHALL be the model and effort of the kind in force, resolved through the configuration layers as the flat keys `model` and `effort`: an argument (a `start` argument, a `--set` flag, or a runtime override) beats the file, which beats the default, and the resolved record SHALL carry the source of each. An argument MAY name a kind's key directly (`claude.model`, `codex.effort`); a flat `model` or `effort` argument SHALL bind to the kind in force when it is written, or to a `runnerKind` in the same patch, so changing the kind later does not carry one kind's model to another. Neither key SHALL be detected or pinned, and neither SHALL be start-only.

#### Scenario: Defaults without a file
- **WHEN** the daemon starts in a repository with no `orchestrator.yaml` and no overrides
- **THEN** `config.model` is `{ value: "claude-opus-5-5", source: "default" }` and `config.effort` is `{ value: "medium", source: "default" }`

#### Scenario: File sets the model and an argument sets the effort
- **WHEN** `orchestrator.yaml` sets `runner.claude.model: opus` and the daemon starts with `--set effort=high`
- **THEN** `config.model` is `{ value: "opus", source: "file" }` and `config.effort` is `{ value: "high", source: "argument" }`

#### Scenario: Codex default model
- **WHEN** the file sets `runner.kind: codex` and no model
- **THEN** `config.model` is `{ value: "gpt-6-astra", source: "default" }`, not a Claude model

#### Scenario: Stored flat override read as Claude Code's
- **WHEN** a run's stored override document, written before runner kinds, holds `{ model: "opus" }`
- **THEN** it is read as `claude.model`, and under `claude-code` `config.model` is `{ value: "opus", source: "argument" }`

### Requirement: Task selectors
A task MAY carry `model` and `effort` in its payload. A present `effort` SHALL be one of the levels some runner kind accepts (`low`, `medium`, `high`, `xhigh`, `max`, and `ultra` for `codex`; see worker-runners "Per-kind effort sets"), and a present `model` SHALL be a string matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`; a present value of any other shape SHALL fail graph validation naming the node and the key. A task without a selector SHALL use the run default for that key.

#### Scenario: Selectors load from the graph file
- **WHEN** a node declares `model: claude-sonnet-5-5` and `effort: low`
- **THEN** the loaded node's payload carries both values

#### Scenario: Codex-only level loads
- **WHEN** a node declares `effort: ultra`
- **THEN** the loaded node's payload carries `effort: ultra`

#### Scenario: Invalid effort refused at load
- **WHEN** a node declares `effort: huge`
- **THEN** loading fails and the error names the node and `effort`

#### Scenario: Unsafe model refused at load
- **WHEN** a node declares `model: "opus; rm -rf /"`
- **THEN** loading fails and the error names the node and `model`

### Requirement: Resolution fixed at preparation
When a launch is prepared the daemon SHALL set the launch's `model` to the task's `model` when present, else the run default, and its `effort` likewise, and SHALL record both in the `launch.created` event payload. The values SHALL NOT change for that launch afterwards: a later override applies to launches prepared after it, and a retry is a new launch that resolves again from the task and the run default in force at that time.

#### Scenario: Task selector wins over the run default
- **WHEN** the run default effort is `medium` and T2 declares `effort: high`
- **THEN** T2's launch has `effort: high` and T1's launch, with no selector, has `effort: medium`

#### Scenario: Override applies to later launches only
- **WHEN** T1's launch was prepared under model `claude-opus-5-5`, the operator sets `model` to `claude-sonnet-5-5`, and T2 is prepared afterwards
- **THEN** T1's launch still has `claude-opus-5-5` and T2's launch has `claude-sonnet-5-5`

#### Scenario: Retry resolves again
- **WHEN** T1's first launch failed under effort `medium` and the operator set `effort` to `high` before the retry was prepared
- **THEN** the retry launch has `effort: high`

### Requirement: Runners and workers receive the values
The spawn runner SHALL fill `{model}` and `{effort}` in the runner command from the launch at every spawn. The claim response SHALL carry the launch's `model` and `effort`. The daemon SHALL NOT validate a model name against any list: a name the CLI rejects fails the launch at spawn, and the failure is recorded by health monitoring like any other dead process.

#### Scenario: Spawned command carries the flags
- **WHEN** a launch with `model: claude-opus-5-5` and `effort: medium` is spawned with the default runner command
- **THEN** the command run contains `--model claude-opus-5-5 --effort medium`

#### Scenario: Claimed launch carries the values
- **WHEN** a worker claims a launch whose task declares `model: claude-sonnet-5-5`
- **THEN** the claim response has `model: "claude-sonnet-5-5"` and the run default `effort`

#### Scenario: Unknown model fails the launch
- **WHEN** a task declares `model: not-a-model` and its launch is spawned
- **THEN** the process exits at once, the launch ends dead, and the task's attempt is recorded as failed with the exit visible in the launch log

### Requirement: Selection visible to operators
`status.liveLaunches[]` SHALL carry each launch's `model` and `effort`. The configuration block in `status`, `config.json`, `GET /v1/config`, and the `start` result SHALL carry `model` and `effort` as `{ value, source, applied }`, where `applied` is whether the runner command in force contains the corresponding slot.

#### Scenario: Live launch shows its selection
- **WHEN** T2 is live with `effort: high`
- **THEN** `status.liveLaunches` has an entry for T2 with `effort: "high"` and its `model`

#### Scenario: Verbatim runner command marks the keys unapplied
- **WHEN** the file sets `runnerCommand` to a command without `{model}` or `{effort}`
- **THEN** `config.model.applied` and `config.effort.applied` are both false
