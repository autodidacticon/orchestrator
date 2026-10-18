# Tasks

## 1. Fixtures

- [x] 1.1 Replace the ten files under `test/fixtures/codex/` with byte copies of the probe originals (`cmp` clean); keep `two-turns.jsonl`
- [x] 1.2 Rewrite `test/fixtures/codex/README.md`: byte copies, their sources, and `two-turns.jsonl` as the one hand-written file

## 2. Classifier

- [x] 2.1 Narrow `AUTH_FAILED` and anchor `APPROVAL` to the observed wording in `src/runner/codex.ts`
- [x] 2.2 Read `sandboxDenied` from any failed `command_execution` item, else from an `agent_message`, after `turnFailed`
- [x] 2.3 `exitBeforeTurn` detail only from an error line on stderr

## 3. Tests and spec

- [x] 3.1 Move `test/runner/codex.test.ts` and `test/slice/codex.test.ts` to the real fixture contents; add the three negative cases (CODEX_HOME authentication line, `EACCES` tool error, denied command followed by a successful one)
- [x] 3.2 task-lifecycle "Health failure reasons" delta with the new rules and scenarios
- [x] 3.3 Check command green: `npm ci --ignore-scripts && npm run build && npx vitest run --retry 2`
