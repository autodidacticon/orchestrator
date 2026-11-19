## Why

Pull mode records no usage for a remote launch: the daemon reads cost from a local log only for spawned launches, and the remote worker loop sends the agent's output to its own stderr and keeps none of it. The daemon side exists (`POST /v1/launches/:id/usage`, specs/pull-runner "Worker usage", priced and counted by `budgets.maxRunCostUsd`), so only the worker side is missing (ORC-29, cloud-native M4).

## What Changes

- New `src/worker/usage.ts`: `TailKeeper`, which keeps the last 256 KiB of a stream, and `usagePostBody`, which parses the kept text with `parseUsage` (src/runner/claude-code.ts, unchanged) and answers `{ workerId, usage: { tokens, model?, costUsd? } }` or nothing. `model` is the claim's model when it has one; `costUsd` is `total_cost_usd` when above zero; turns and duration are not posted.
- `src/worker/loop.ts`: the command agent's standard output also feeds the keeper (it still goes to stderr; standard error is not kept). The kept text is parsed once the agent process has exited. The post is the last step of a launch: after `report accepted`, after a release, after an ended launch, and on termination after a release that was answered, whatever its status (skipped when the push failed or the release got no answer). A recorded post prints `worker <id> usage <launchId> <taskId>`; any other answer, or a post that cannot be sent, goes to stderr and changes neither the verdict nor the exit code.
- `deploy/README.md` "The workers" describes the post.
- The daemon, `src/worker/terminate.ts`, `clone.ts` and `http.ts` are not changed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `worker-pool`: ADDED "Usage post".

## Impact

- New `src/worker/usage.ts`; `src/worker/loop.ts`; `deploy/README.md`.
- Tests: `test/worker/usage.test.ts`, `test/slice/worker-usage.test.ts` with the agent `test/agents/usage-agent.ts`.
