## Why

Since `runtime-limit-keys` (ORC-116), a lowered or cleared `budgets.maxLaunchMs` or `health.stuckFailAfterMs` applies on the next tick. A mistyped value, or the clearing of a temporary raise, then ends live launches at once, each with an attempt spent and its uncommitted work lost (ORC-110).

## What Changes

- `PUT /v1/config` refuses with 409 a change that would end a live launch: for a `live` launch that holds the lease of a `running` task, the limits in force after the patch end it now and the limits in force before do not. The body is `{ ok: false, error, wouldEnd: [{ taskId, launchId, limit, value, elapsedMs | idleMs }] }`, and nothing of the patch is applied.
- Every shape of patch is covered: a lower value, a null leaf that clears a raise, a null block, a limit switched on from 0. A lowered `health.stuckAfterMs` only flags a launch and is never refused.
- The confirmation is `endLive: true` in the body of the route, `endLive` on the `configure` tool and `--end-live` on `orchestrator-ctl config`. It is not a configuration key: not stored, not validated with the patch, not listed under `applied`. The `operator.config` event records `endLive: true` when given. `endLive` alone is answered 200 with `applied: []` and stores nothing.
- Order of refusals: 400 for an invalid patch (the pair rule included), then 409 for a start-only key with its present body, then the 409 with `wouldEnd`.
- The guard and the checks share one comparison each: `exceedsTimeBudget` in `src/health/budgets.ts` and `exceedsStuckFail` in `src/health/stuck.ts`, over the elapsed and idle times the checks take (gaps in the daemon's clock left out). The guard reads the store only.
- The guard covers the route only: a daemon spawned with `--set` and a changed file apply their limits on the first tick. The `start` tool takes no `endLive`; on a running daemon a refused limit lands under `rejected` with the route's error text.
- The run skills tell the agent to show `wouldEnd` to the user and send `endLive` only on the user's say.

This change builds on `runtime-limit-keys` ("Configuration route: limit keys", "Configuration command: set flags", "Configure and start tools: limit keys", "Run skill offers a raised limit") and does not restate those requirements.

## Capabilities

### Modified Capabilities

- `operator-control`: ADDED "Configuration route: a change that would end a live launch".
- `operator-mcp`: ADDED "Configure tool: endLive".
- `host-integration`: ADDED "Run skill confirms a lowering with the user".

## Impact

- `src/health/stuck.ts`, `src/health/budgets.ts` (the comparison moved into an exported function), `src/loop/orchestrator.ts` (`setConfig` options and the guard), `src/runs/resolve.ts` (`SetConfigResult` variant, `WouldEnd`), `src/operator/routes.ts`, `src/operator/mcp-server.ts`, `src/operator/cli.ts`.
- `hosts/*/skills/run/SKILL.md`.
