## 1. Classifier

- [x] 1.1 `src/graph/diff.ts`: suppress `kindChangedStarted` when `old.kind === 'task'`, `nu.kind === 'external'`, the entry status is `done`, and `nu.done` is true; the node stays in `changed`
- [x] 1.2 `test/graph/diff.test.ts`: the three new scenarios (accepted done→done external; refused done→external `done: false`; refused running→external)

## 2. Skill and finish

- [x] 2.1 `hosts/claude-code/skills/import/SKILL.md` GitHub section: re-import after publication needs no special handling; reopening is `reopen`, not import
- [x] 2.2 `npm test` green, gated on the test command's exit status; `openspec validate allow-finished-task-reimport`. Outcome: exit 0, 414 passed, 3 skipped, no flakes this run
