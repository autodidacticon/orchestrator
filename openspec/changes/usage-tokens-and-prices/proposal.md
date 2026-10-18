## Why

`Usage` holds only `costUsd`, `turns`, and `durationMs`, and `recordUsage` drops a usage that has none of them. Codex reports tokens (`turn.completed.usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`) and no dollar cost or duration, so even a correct Codex parser would record nothing: `status.cost.byTask` stays empty, `budgets.maxRunCostUsd` never pauses a Codex-heavy run, and the operator cannot tell a free launch from one whose cost is unknown.

## What Changes

- `Usage` gains `tokens?: { input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` and `source?: 'claude-code' | 'codex' | 'scripted' | 'worker'`. The launch row gains `tokens`, `usageSource`, and `costSource: 'reported' | 'priced'`. The launches table stores a JSON document, so no migration is needed.
- `recordUsage` counts a present `tokens` as usage in both of its guards, stores every field, and puts the whole usage (with `costSource`) in the `launch.usage` payload. `durationMs` stays unset when the runner gives none.
- `parseUsage` (Claude) lifts `usage.input_tokens`/`output_tokens` and the cache fields into `tokens`, so both fleets record the same shape. Claude's `input_tokens` excludes cache reads, so cache reads are added to `input` to match the pricing formula.
- `budgets.prices`: per-model rates in USD per million tokens (default `{}`; keys checked by the model-name pattern; rates non-negative). A pure `priceUsage(tokens, price)` in `src/health/budgets.ts`. A launch whose runner yields tokens without a cost is priced at record time when its model has a price (`costSource: 'priced'`); a runner-reported cost is `reported` and never re-priced. Without a price the cost stays unknown, the launch counts in `status.cost.unpricedLaunches`, and the daemon logs one warning per model.
- `status`: `liveLaunches[].tokens`, `cost.unpricedLaunches`, and `tokens: { run, byTask }` beside `cost`.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `health-monitoring`: `Usage accounting` is runner-neutral and names `tokens` as a stored field; `Run cost budget` gains `budgets.prices`, the pricing formula with its two assumptions, and unpriced launches.
- `operator-control`: `Status report: health facts` lists `tokens` and `unpricedLaunches`.

## Impact

- Code: `src/runner/runner.ts` (`TokenUsage`, `UsageSource`), `src/runner/claude-code.ts` (`parseUsage`), `src/state/store.ts` (`Launch`), `src/loop/orchestrator.ts` (`recordUsage`, `status`), `src/health/budgets.ts` (`priceUsage`, `priceFor`, `unpricedLaunches`, `tokensOf`), `src/config.ts` (`budgets.prices`, `priceSchema`).
- Behaviour: a Claude Code run records the same cost as before plus its tokens. A run with tokens but no prices shows `runUsd` 0 while spending; `unpricedLaunches` makes the gap visible but does not pause admission. Price tables go stale and are the operator's to maintain.
