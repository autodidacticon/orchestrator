## ADDED Requirements

### Requirement: Profile hold at admission

When the profile hold is on (see operator-control "Profile hold key"), a task SHALL have a held profile when its status is `unstarted` and at least one of its keys, `model` or `effort`, is missing. A key SHALL be missing when all three hold: its value would come from the leaf of the task's runner kind and not from the task's payload; that leaf's source is `default`; and it is not the case that the runner mode in force is `spawn` and the kind's command template has no slot for the key. In `pull` and `mixed` mode the slot SHALL NOT be consulted, and the mode SHALL be read every time the rule is evaluated. The runner kind SHALL never be a reason to hold.

The hold SHALL narrow task-lifecycle "Admission" as the scope filter (scheduling-policy "Scope filter at admission") does: a ready task with a held profile SHALL be removed from the `ready` list before admission. It SHALL take no capacity, defer no other task and not be listed in `status.deferred`. It SHALL stay `unstarted` and SHALL NOT be transitioned, and no launch row and no event SHALL be written for it.

Confirming SHALL be setting: any value of the kind's model or effort from `start`, `configure`, `--set` or `orchestrator.yaml` SHALL end the hold for that key, also when it equals the built-in value. There SHALL be no confirm call and no new stored state for it.

Only admission SHALL be held. A waiting task that is resumed, a parked launch, a live launch and a recovery launch of the same attempt SHALL NOT be held. A retry, and a launch after a release, an unblock or a reopen, come from admission and SHALL be held like a first launch. The profile hold SHALL NOT be a pause and SHALL NOT be the hold after a gap: `paused` and `stalled` SHALL stay false, and the idle exit SHALL work as for a quiet run. The hold SHALL NOT change any built-in model or effort.

#### Scenario: A task on built-in defaults is held

- **WHEN** the profile hold is on, the run's `claude-code` model and effort come from built-in defaults, and two tasks are ready: A with no selector and B with `model` and `effort` in its payload
- **THEN** after a tick B has a launch, and A is `unstarted` with no launch row, no `launch.created` event and no transition
- **AND** `status.paused` and `status.stalled` are false and `status.deferred` is empty

#### Scenario: A held task takes no capacity

- **WHEN** the profile hold is on, `capacity` is 1, a held task sorts first and a second ready task has both selectors
- **THEN** one tick launches the second task

#### Scenario: Setting the built-in values confirms them

- **WHEN** a held task's run sets `model: claude-opus-5-5` and `effort: medium` through `configure`
- **THEN** on the next tick the task has a launch with that model and effort, and the configuration reports source `argument` for both

#### Scenario: One key set is not enough

- **WHEN** only the model is set
- **THEN** the task stays `unstarted` and its missing keys are `["effort"]`

#### Scenario: The hold is per kind

- **WHEN** a `claude-code` run has set its model and effort, and a task with `runner: codex` and no other selector is ready while the `codex` leaves are defaults
- **THEN** the task is held with runner `codex` and missing keys `["model", "effort"]`
- **AND** after `codex.model` and `codex.effort` are set it is launched on the next tick

#### Scenario: A value the kind does not take does not confirm

- **WHEN** a task with `model: opencode/big-pickle` and `effort: high` is ready on a `claude-code` run whose leaves are defaults
- **THEN** the model is not bound, its source is the leaf's `default`, and the task is held with missing keys `["model"]`

#### Scenario: A slot the template lacks does not hold in spawn mode

- **WHEN** the profile hold is on, the mode is `spawn`, and the kind's command template has neither `{model}` nor `{effort}`
- **THEN** a task with no selector has no missing key and is launched
- **AND** with the mode `pull` or `mixed` the same task is held with missing keys `["model", "effort"]`, and after the mode is set to `spawn` it is launched on the next tick

#### Scenario: Only admission is held

- **WHEN** the profile hold is on, two tasks were launched after the model and effort were set, one of them is waiting on a question, and both keys are then cleared
- **THEN** the waiting task is resumed when its answer arrives, and the other launch stays live
- **AND** when the other task's attempt fails it returns to `unstarted` and gets no further launch until both keys are set again

### Requirement: Profile sources of a task

The profile of a task SHALL be the `runner`, `model` and `effort` that `selectionFor` returns for it, each key with a source: `task` exactly when `selectionFor` takes the payload's value (for the effort, the requested value or its fallback for the kind), else the source of the leaf of the task's runner kind, `argument`, `file` or `default`, as resolved for that kind with the stored overrides. An in-memory configuration with no file SHALL count as the file for a value that differs from the default. The sources SHALL be read for every runner kind, the kind in force included, by one rule. `selectionFor`'s return value, the launch row and `launch.created` SHALL keep their shape.

#### Scenario: An effort fallback comes from the task

- **WHEN** a task with `effort: ultra` runs under `claude-code`
- **THEN** its profile has `effort` `max` and `effortSource` `task`

#### Scenario: A file value is a file source

- **WHEN** `orchestrator.yaml` sets `runner.claude.model` and `runner.claude.effort`, also to the built-in values, and a task has no selector
- **THEN** its profile has `modelSource` and `effortSource` `file`, and the profile hold does not hold it

#### Scenario: An unbound model takes the leaf's source

- **WHEN** a task with a `provider/model` selector runs under `claude-code` or `codex`
- **THEN** its model is the kind's leaf value and `modelSource` is that leaf's source
