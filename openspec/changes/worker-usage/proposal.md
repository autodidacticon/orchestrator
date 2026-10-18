## Why

A claimed launch has no pid and no log file, and `recordUsage` asks only the runner, whose reader parses the launch log. Every pull-mode launch therefore ends with unknown usage, and the run cost budget is inert for it. This already affects Claude workers in pull mode, and Milestone 2 runs Codex workers in pull mode.

Usage cannot travel in the agent's `report`: Codex prints `turn.completed{usage}` on stdout after the turn, so the worker loop has the number only after the agent's `report` went through, and the agent does not know its own token count. By then the launch token no longer works: `report` answers 409 once the task is `submitted`, a pid-less launch is ended on the tick after the submit, and `authenticate` refuses a launch that is not `live` or `launching`. A sixth agent operation would also break agent-protocol's "exactly five operations".

## What Changes

- New operator route `POST /v1/launches/:id/usage { workerId, usage: { tokens, model?, costUsd? } }`, identified by the body like `/v1/claims` and `/v1/launches/:id/release`, with no launch token. It is accepted for a launch with a `worker` whose id matches and no pid, in status `live` or `ended`. A launch with a pid is refused with 409: the runner stays the only source for spawned launches. When the launch already has usage, the post is a no-op answered 200 with `recorded: false`. The body is checked strictly (non-negative integer token counts, non-negative cost); a bad body is 400.
- The usage is stored as the runner's is: on the launch row and as `launch.usage`, with `source: 'worker'`. A tokens-only usage is priced with the posted `model`, else the launch's model. A posted `costUsd` is kept as `reported`. The request is recorded as `operator.usage` before its effect.
- `recordUsage` is split. It reads from the runner and skips a claimed launch. A shared `storeUsage` prices and stores. `recordWorkerUsage` checks the post and calls `storeUsage`.
- The agent shim and the five agent operations are unchanged.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `pull-runner`: new requirement `Worker usage`.
- `health-monitoring`: `Usage accounting` names the worker route as a second source with provenance; a claimed launch yields no runner usage.
- `operator-control`: `Claims and releases` lists the usage route.

## Impact

- Code: `src/loop/orchestrator.ts` (`recordUsage`, `storeUsage`, `recordWorkerUsage`, `workerUsageBodySchema`), `src/operator/routes.ts`.
- Callers: the Codex work loop (codex-work-loop) posts the summed `turn.completed.usage` after `codex exec` exits. That loop is not on this branch. Whether the Claude Workflow `agent()` returns usage for `work.js` to post is unverified, so `work.js` is unchanged.
- Self-reported usage is not authoritative: a worker can omit or misstate it. `usageSource: 'worker'` keeps it distinguishable, and because launches with a pid are refused, the two sources never meet on one launch.
