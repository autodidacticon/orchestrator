## MODIFIED Requirements

### Requirement: Resolution fixed at preparation
When a launch is prepared the daemon SHALL set the launch's `runner` to the runner kind in force, its `model` to the task's `model` when present, else the default model of that kind (never another kind's), and its `effort` to the task's `effort` when present, else the default effort of that kind. The effort SHALL be checked against the chosen kind's effort set before the kind's fallback applies: a level the kind accepts is kept, a level it lacks is replaced by the kind's fallback (`ultra` as `max` for `claude-code`), and the level asked for SHALL then be recorded as `effortRequested`. The daemon SHALL record `runner`, `model`, and `effort`, and `effortRequested` when present, in the `launch.created` event payload. The values SHALL NOT change for that launch afterwards: a later override (of the kind, the model, or the effort) applies to launches prepared after it, and a retry is a new launch that resolves again from the task and the run default in force at that time.

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

#### Scenario: Ultra falls back under Claude Code
- **WHEN** a task declares `effort: ultra` and the run kind is `claude-code`
- **THEN** its launch has `effort: "max"` and `launch.created` carries `effortRequested: "ultra"`; under `codex` the launch keeps `effort: "ultra"` and no `effortRequested` is recorded

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
