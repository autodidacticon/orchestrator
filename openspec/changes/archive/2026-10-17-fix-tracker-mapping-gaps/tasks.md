## 1. Mapping

- [x] 1.1 `src/import/mapping.ts`: the external node's `done` is true for `done` and `cancelled`; `src/operator/mcp-server.ts` `import_issues` description and `hosts/claude-code/skills/import/SKILL.md` say cancelled children count as satisfied
- [x] 1.2 `test/import/mapping.test.ts`: a cancelled child is external with `done: true` and `trackerState: cancelled`, and a task blocked by it has it as a satisfied dependency

## 2. Run skill

- [x] 2.1 `hosts/claude-code/skills/run/SKILL.md` GitHub branch: `done` and `cancelled` also run `gh issue edit <url> --remove-label <inProgressLabel>` when a label is configured
- [x] 2.2 `test/host/package.test.ts` asserts `--remove-label` in the run skill

## 3. Finish

- [x] 3.1 `npm test` green; `openspec validate fix-tracker-mapping-gaps`; re-check the dummy repository's closed issues by hand (remove the stale labels from #2 and #6). Outcome: full suite 409 passed with one load flake in `test/slice/import.test.ts` (overlapping-scopes launch ordering, no cancelled children in its fixture) that passed alone; stale labels removed from dummy #2 and #6
