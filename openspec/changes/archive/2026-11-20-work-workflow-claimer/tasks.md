## 1. Workflow

- [x] 1.1 Claimer claims with `brief: false`, returns `briefPath`, and has no `briefMarkdown` in its schema; the worker prompt names `briefPath` and says to read the whole file first
- [x] 1.2 Claimer waits with `until "any"` and `timeoutMs` 90000, takes the seven fields from the `wait` digest, never calls `status`, and returns early only on `finished` or `stalled`
- [x] 1.3 Top-level `stopRule(d, othersHold)` decides when a loop stops
- [x] 1.4 A silent claimer is retried once, with the two log lines; an `error` answer ends the loop with a log line

## 2. MCP tool

- [x] 2.1 `claim` takes an optional boolean `brief`; with `false` the tool drops `brief` from the answer, and the description names the option

## 3. Docs and tests

- [x] 3.1 The work skill says the claimer reads the `wait` digest
- [x] 3.2 Stub runs of `work.js` and a `stopRule` table in `test/host/work-loop.test.ts`; `brief: false` in `test/slice/worker-tools.test.ts`
- [x] 3.3 `openspec validate work-workflow-claimer --strict`, and archive in a copy of `openspec/` followed by `openspec validate --specs --strict`
