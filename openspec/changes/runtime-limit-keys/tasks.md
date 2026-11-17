## 1. Resolution

- [x] 1.1 `budgets` and `health` in `OVERRIDABLE_KEYS` and the strict override schema; a second list of limit blocks beside the runner-kind namespaces, used by the per-leaf merge, the refusal name, the dotted keys and `parseSetFlags` (`src/runs/resolve.ts`)
- [x] 1.2 `parseSetFlags`: the three dotted keys as decimal digits only; the JSON-object form kept for the spawn path
- [x] 1.3 `resolveLayers`: the three leaves with value and source, read from the file's nested blocks; written into `config.budgets` and `config.health`
- [x] 1.4 The pair rule in `applyOverridePatch`, only for a patch that touches a stuck limit (`stuckPairProblem`)
- [x] 1.5 `ConfigReport.config`, `reportOf` and `configSummary` carry `budgets` and `health`

## 2. Readers

- [x] 2.1 `checkStuck` and `checkTimeBudget` read the limit through `effective()` (one expression each)
- [x] 2.2 The claim's `health.stuckFailAfterMs` and `status.budgets` read through `effective()`
- [x] 2.3 `src/main.ts`: usage text names the keys; usage first and refusal last at both refusal sites; one warning at start when the pair in force breaks the rule

## 3. Operator surfaces

- [x] 3.1 MCP `configure` (nullable) and `start` take strict `budgets` and `health` objects; descriptions extended
- [x] 3.2 `orchestrator-ctl config --set` through `parseSetFlags`, merged per leaf; a leaf named twice refused before any call; usage extended

## 4. Skills and tests

- [x] 4.1 The run skills' bullet "a launch needs more time"; a pointer from the stuck bullet
- [x] 4.2 Tests in `test/runs/resolve.test.ts`, `test/loop/health.test.ts`, `test/loop/config.test.ts`, `test/loop/lease.test.ts`, `test/runs/lifecycle.test.ts`, `test/slice/config.test.ts`, `test/slice/operator-mcp.test.ts` and the host tests
