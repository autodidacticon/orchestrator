## ADDED Requirements

### Requirement: Wait digest: profileHeld

The wait digest SHALL carry `profileHeld`: one entry `{ runner, missing, tasks }` per runner kind that has a task with a held profile (model-selection "Profile hold at admission"). `missing` SHALL be the union of the missing keys over that kind's held tasks, `model` before `effort`, and `tasks` SHALL count them. Entries SHALL be ordered by their first held task in graph order. It SHALL be an empty list when nothing is held and when no graph is loaded. No event SHALL be written when a task becomes held; a session learns of it from `status.profiles` and from the digest of its next `wait` return. `needsConfig` SHALL be unchanged.

#### Scenario: A held task is in the digest

- **WHEN** the profile hold is on and a ready `claude-code` task with no selector is held after only the model was set
- **THEN** the digest's `profileHeld` is `[{ runner: "claude-code", missing: ["effort"], tasks: 1 }]`
- **AND** after both keys are set and a tick, `profileHeld` is `[]`

#### Scenario: Without a graph

- **WHEN** no graph is loaded
- **THEN** the digest's `profileHeld` is `[]`
