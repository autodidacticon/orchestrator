## Why

`budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs` were read once at start. An operator who saw a launch near its time budget, or a silent launch they wanted to keep, could only nudge the worker or restart the daemon with a changed file (ORC-116).

## What Changes

- The three keys become durable overrides, nested as in the config file: `{ budgets: { maxLaunchMs }, health: { stuckAfterMs, stuckFailAfterMs } }` in the stored document and in the body of `PUT /v1/config`; `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs` for `--set` and `--clear`; the objects `budgets` and `health` in the MCP `configure` and `start` tools. No other leaf of `budgets` or `health` is accepted.
- A value is an integer from 0 to `Number.MAX_SAFE_INTEGER`; 0 disables the limit; a null leaf clears that override and a null block clears both of its leaves. `--set` reads the three values as decimal digits only.
- Pair rule: a patch that touches either stuck limit is refused when the pair in force after it has both values above 0 and `stuckFailAfterMs` not above `stuckAfterMs`. The refusal names the key and gives both keys, both values and the source of each. A patch that touches neither key is not checked. At start a pair in force that breaks the rule is logged as one warning, not refused.
- The stuck check, the time budget check, the claim's `health.stuckFailAfterMs` and `status.budgets` read the limits through the effective configuration, so a change applies on the next tick. `status.budgets.maxRunCostUsd` stays a start-time value.
- The configuration report, `config.json` and the `config.resolved` event carry `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs` as `{ value, source }`.
- `orchestrator-ctl config` reads `--set key=value` (repeatable) for every key and merges it into the one PUT. One call names each leaf once: the same leaf, or a block and a leaf under it, given by two of `--set`, `--clear` and the per-key flags is refused before anything is sent.
- The daemon writes its usage text before a `--set` refusal, so a caller that reads the tail of the daemon log (`start` on a stopped run) sees the refusal whole.
- The run skills offer a raised limit in a bullet of its own.

## Capabilities

### Modified Capabilities

- `toolchain-discovery`: ADDED "Runtime limit overrides", "Limit leaves in the resolved configuration record".
- `operator-control`: ADDED "Configuration route: limit keys", "Configuration command: set flags", "Status report: limits in force".
- `health-monitoring`: ADDED "Limits read at every check".
- `pull-runner`: ADDED "Claim states the limit in force".
- `operator-mcp`: ADDED "Configure and start tools: limit keys".
- `host-integration`: ADDED "Run skill offers a raised limit".

## Impact

- `src/runs/resolve.ts` (schema, merge, `parseSetFlags`, `resolveLayers` leaves, `stuckPairProblem`, report), `src/health/stuck.ts` and `src/health/budgets.ts` (one expression each), `src/loop/orchestrator.ts` (claim, status), `src/main.ts` (usage, refusal order, start warning), `src/operator/mcp-server.ts`, `src/operator/cli.ts`.
- `hosts/*/skills/run/SKILL.md`.
- A downgrade to 0.5.1 reads a stored document that holds a limit override as empty; the upgrade notes (task 2) say so.
