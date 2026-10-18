## 1. Tokens on the row

- [x] 1.1 `src/runner/runner.ts`: `Usage.tokens`, `Usage.source`, `TokenUsage`, `UsageSource`; `src/state/store.ts`: `Launch.tokens`, `usageSource`, `costSource`
- [x] 1.2 `src/loop/orchestrator.ts` `recordUsage`: `tokens` counts as usage in both guards; every field stored; the whole usage and `costSource` in `launch.usage`
- [x] 1.3 `src/runner/claude-code.ts` `parseUsage`: `tokens` from `usage.input_tokens`/`output_tokens` and the cache fields; `source: 'claude-code'`
- [x] 1.4 `test/health/usage.test.ts`, `test/state/sqlite.test.ts`

## 2. Prices

- [x] 2.1 `src/config.ts`: `budgets.prices` (`priceSchema`, keys by `modelSchema`, default `{}`)
- [x] 2.2 `src/health/budgets.ts`: `priceUsage` with the formula, `priceFor` (own keys only), `unpricedLaunches`, `tokensOf`
- [x] 2.3 `recordUsage` prices tokens without a cost when the launch's model has a price (`priced`), keeps a runner cost (`reported`), and warns once per unpriced model
- [x] 2.4 `test/health/budgets.test.ts`

## 3. Status

- [x] 3.1 `status`: `liveLaunches[].tokens`, `cost.unpricedLaunches`, `tokens: { run, byTask }`
- [x] 3.2 `test/loop/health.test.ts`: tokens only and unpriced; priced launches crossing the budget; a reported cost kept; `test/slice/events.test.ts`

## 4. Finish

- [x] 4.1 Spec deltas for health-monitoring and operator-control; `openspec/specs/` is updated when the change is archived
