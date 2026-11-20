## 1. Workflow

- [x] 1.1 Remove `stopRule` and `held` from `hosts/claude-code/workflows/work.js`; end a loop on the verdicts `finished`, `stalled` and `human`
- [x] 1.2 Claimer prompt and `CLAIM_SCHEMA` take `workByKind["claude-code"]` (`verdict`, `claimable`, `preparing`, `working`), `openQuestions` and `awaitingReview`
- [x] 1.3 An answer without a verdict ends the loop with a log line
- [x] 1.4 The workflow result's `digest` carries the verdict, with `finished` and `stalled` derived from it

## 2. Skills

- [x] 2.1 Run skill section 1a and work skill section 2 state the new loop end and no longer name `preparingByKind`

## 3. Tests

- [x] 3.1 `test/host/work-loop.test.ts`: prompt and schema, verdict table through `runWorkflow`, two loops, no verdict, workflow result
- [x] 3.2 `test/host/package.test.ts`: `work.js` contains `workByKind["claude-code"]`
