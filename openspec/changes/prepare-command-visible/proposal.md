## Why

After ORC-130 (task 84c) a launch can stay `preparing` for minutes while its prepare command runs, and after ORC-131 (task 84f) a task can wait for a prepare retry. `status` shows neither, both work loops read "nothing claimable" as quiet and can stop during an install, the brief does not say that dependencies were installed, and the time a prepare command takes counts against a claimed launch's time budget. ORC-132 (release 0.6.0 task 84e) closes these.

## What Changes

- `status` gains `preparing` (task ids of launches in `preparing` or `launching`, oldest first), `prepareRetry` (`[{ taskId, failures, retryAt }]` for retry entries of `unstarted` tasks, by `retryAt`, then task id) and `preparingByKind` (both, per runner kind, every kind present). Derived from the store only; the retry entries are read through `pendingPrepareRetries`, and only when `prepareCommand` is set.
- The wait digest gains `preparing` (the sum of `preparingByKind`) and `preparingByKind`. The bodies without a graph carry empty and zero values.
- `orchestrator-work`: a run is not quiet while `preparingByKind.<kind>` is above 0; a status without the field counts as 0.
- Claude Code workflow: the claimer's stop rule also needs `preparingByKind["claude-code"]` (0 when absent) to be 0.
- The five texts that state when a loop stops name `preparing` or `preparingByKind`.
- The brief of a launch prepared while `prepareCommand` is set gains one Definition of done bullet after the check command bullet, and `brief.json` gains `prepareCommand`.
- A claimed launch's elapsed time starts at `claimableAt`: the start is `spawnedAt`, else `claimableAt`, else `createdAt`.

## Capabilities

### New Capabilities

### Modified Capabilities
- `operator-control`: ADDED "Status report: launches being prepared".
- `host-integration`: MODIFIED "Work loop by runner kind" and "Work skill and workflow".
- `agent-protocol`: ADDED "Prepare command in the brief".
- `health-monitoring`: ADDED "Time budget of a claimed launch".

## Impact

`src/health/budgets.ts`, `src/loop/orchestrator.ts`, `src/operator/routes.ts`, `src/operator/mcp-server.ts`, `src/brief/compose.ts`, `src/workspace/workspace.ts`, `hosts/codex/bin/work.mjs`, `hosts/claude-code/workflows/work.js`, the three run skills, the Claude Code work skill, `hosts/codex/README.md`, and tests.
