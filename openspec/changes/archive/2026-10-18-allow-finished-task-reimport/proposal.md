## Why

Re-importing an epic after the run has published some of its tasks is refused. The tracker now shows those issues closed, so the import maps them to external nodes, and the reload classifier treats a started task changing kind as incompatible ("kind of GH-7 changed while started"). The run's own success makes the next import fail, for every tracker. The GitHub test needed a workaround that kept the run's task ids as open records; the daemon should accept the honest graph instead.

## What Changes

- The reload classifier accepts a `task` becoming an `external` node when the task's entry is `done` and the new node's `done` flag is true. The entry stays `done`; the node is listed under `changed`. Every other kind change of a started task is still refused, including a done task becoming an external with `done: false` and the reverse direction.
- The import skill's GitHub section drops the keep-tasks workaround and says a re-import after publication is accepted as is.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `task-graph`: `Reload compatibility` admits the finished-task-to-done-external case with two scenarios and names the two refusals that remain.
- `host-integration`: `Import skill records the tracker` notes that re-imports after publication need no special handling (one sentence).

## Impact

- Code: `src/graph/diff.ts`, `test/graph/diff.test.ts`, `hosts/claude-code/skills/import/SKILL.md`.
- Behaviour: a re-import that reflects the run's own publications is accepted; nothing else about reload compatibility changes.
