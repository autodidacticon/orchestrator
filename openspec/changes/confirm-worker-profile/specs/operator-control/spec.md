## ADDED Requirements

### Requirement: Profile hold key

The configuration SHALL have a key `runner.confirmProfile`, a boolean that is `false` by default, so that the daemon by itself never holds a profile. The profile hold in force SHALL be the stored choice when kv `runner.confirmProfile` is `on` (on) or `off` (off), and else the configuration's `runner.confirmProfile`. Any other stored value SHALL be ignored. The stored choice SHALL be read every time the hold is evaluated. See model-selection "Profile hold at admission".

#### Scenario: Off by default

- **WHEN** a run's configuration does not set `runner.confirmProfile` and no choice is stored
- **THEN** `status.runner.confirmProfile` is false and a ready task with no selector is launched on the first tick

#### Scenario: The stored choice is read first

- **WHEN** the configuration sets `runner.confirmProfile: false` and kv `runner.confirmProfile` is `on`
- **THEN** a task with no selector on built-in defaults is held and `status.runner.confirmProfile` is true
- **AND** with the configuration `true` and the kv `off`, the task is launched and the field is false

### Requirement: Status report: profiles

`status` SHALL carry `profiles`, listing every `unstarted` task node grouped into one entry per distinct `{ runner, model, effort, modelSource, effortSource }` (model-selection "Profile sources of a task"). Each entry SHALL carry `held` (a boolean), `missing` (a list holding `model`, `effort`, both or neither, in that order), `tasks` (the count) and `sample` (at most 5 task ids, in graph order). Entries SHALL be ordered by their first task in graph order. A task that has a launch SHALL be in no entry. The list SHALL be present with the profile hold on or off; with it off every entry SHALL have `held: false` and an empty `missing`. `status.runner` SHALL carry `confirmProfile`, the profile hold in force. The body of `GET /v1/status` without a graph SHALL carry `runner.confirmProfile` and `profiles: []`.

#### Scenario: Profiles are grouped and ordered

- **WHEN** the first task of a graph has `model: claude-sonnet-5-5` and the next six have no selector, all `unstarted`
- **THEN** `profiles` has two entries: the first with `tasks: 1`, `modelSource: "task"` and `effortSource: "default"`; the second with `tasks: 6` and a `sample` of the first 5 of those ids in graph order

#### Scenario: A task that waits on a dependency is listed

- **WHEN** the profile hold is on and a task with no selector depends on a task that runs
- **THEN** `profiles` has an entry with `held: true` whose `sample` holds the waiting task

#### Scenario: Without a graph

- **WHEN** a daemon whose configuration sets `runner.confirmProfile: true` has no graph loaded
- **THEN** `GET /v1/status` answers with `runner.confirmProfile` true and `profiles` `[]`
