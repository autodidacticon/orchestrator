## Why

The remote worker loop claims launches of every runner kind, though each worker image runs one CLI, and it never ends its agent when the daemon ends the launch: a heartbeat answered 401 only stops the heartbeats (GH-193). A Claude pod can take an `opencode` launch, and a launch the daemon failed as stuck leaves a hung agent holding the pod. worker-pool "Worker loop: revoked launch" already says a 401 SHALL end that launch's work.

## What Changes

- `ORCH_WORKER_RUNNER`: one runner kind or a comma-separated list. The loop sends it as the claim's `runner` (a string for one kind, a list for several); a value outside the kinds refuses the start with exit 2. Unset sends no filter, as before, and a loop with the `command` agent writes one stderr line saying it claims launches of every runner kind. The parsed kinds are `runnerKinds` in the loop's settings.
- A heartbeat answered 401 ends the command agent. The loop reads the status once: a task `submitted` or `done` gives the agent 30000 ms to exit by itself (so its usage object is printed), any other state or an unreadable status stops it at once. Stopping is `stopAgent` with `ORCH_WORKER_AGENT_STOP_MS`, and the loop prints `agent-ended`. The steps after the agent are unchanged. The scripted agent is unchanged.
- The daemon owns silence: the loop keeps no clock of its own and acts on the daemon's `stuck` through the 401.
- `deploy/worker-claude/Dockerfile` sets `ORCH_WORKER_RUNNER=claude-code`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `worker-pool`: ADDED "Worker loop: runner filter", "Worker loop: runner filter: malformed value", "Worker loop: revoked launch: command agent", "Worker loop: revoked launch: report grace", "Worker loop: revoked launch: unreadable status".
- `cluster-runtime`: ADDED "Claude worker image: runner kind".

## Impact

- `src/worker/loop.ts`: `runnerKinds`, `claimBody`, the start warning, the heartbeat's `onRevoked` callback, the watch on the command agent, `WorkerDeps.reportGraceMs`, `USAGE`.
- `deploy/worker-claude/Dockerfile`, `deploy/README.md`.
- Tests: `test/worker/loop.test.ts`, `test/slice/worker-revoked.test.ts`, `test/agents/linger-agent.ts`, `test/host/worker-image.test.ts`.
