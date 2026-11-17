## 1. Comparisons

- [x] 1.1 `exceedsStuckFail(idleMs, limit)` in `src/health/stuck.ts` and `exceedsTimeBudget(elapsedMs, limit)` in `src/health/budgets.ts`, called by `checkStuck` and `checkTimeBudget`

## 2. Guard

- [x] 2.1 `setConfig(patch, { endLive })`: after the 400 and the start-only 409, list the live launches of running tasks the limits after the patch end and the limits before do not; refuse with `wouldEnd` unless `endLive`
- [x] 2.2 `endLive` on the `operator.config` event, never in the stored document; `endLive` alone stores nothing
- [x] 2.3 `SetConfigResult` gains the `wouldEnd` variant (`src/runs/resolve.ts`)

## 3. Operator surfaces

- [x] 3.1 `PUT /v1/config` takes `endLive` out of the body and answers the `wouldEnd` 409 beside the start-only one
- [x] 3.2 MCP `configure` takes `endLive`, sent beside the folded patch; description extended
- [x] 3.3 `orchestrator-ctl config --end-live`; usage extended

## 4. Skills and tests

- [x] 4.1 The run skills' bullet "a launch needs more time" in the three editions
- [x] 4.2 Tests in `test/loop/health.test.ts`, `test/slice/config.test.ts`, `test/slice/operator-mcp.test.ts` and the host tests
