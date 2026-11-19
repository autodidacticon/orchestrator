## Why

A worker pod deleted in the middle of a launch (eviction, a rollout, a scale-down) commits nothing, pushes nothing and releases nothing: the loop installs no signal handler, so its launch ends only when the lease expires, `leaseTtlMs` later, and an attempt is spent when nothing was pushed. The daemon already accepts a remote release with keep (ORC-23); the worker side has to make one (ORC-28, cloud-native M4).

## What Changes

- New `src/worker/terminate.ts`: stopping the agent's process group within a limit (`stopAgent`), the work-in-progress commit (`commitWorkInProgress`: `git add -A` outside `.orchestrator/`, hooks skipped, identity `orchestrator-worker <worker@orchestrator.local>`), the bounded push (`pushHead`, 30 s), and the hand-back (`handBack`), which answers its outcome as data: the push, and the release's status or that no answer came.
- `src/worker/loop.ts`:
  - The entry point turns SIGTERM and SIGINT into a termination request, which reaches `runWorkerLoop` as `WorkerDeps.termination` (an `AbortSignal`). A second signal changes nothing; after the request the loop claims no more and prints `worker <id> terminating <launchId> <taskId>`.
  - Idle, the loop exits 0 at once. A claim in flight is awaited; its launch is released without keep with reason `podTerminating`. A launch whose clone or agent has not started is released the same way.
  - The command agent runs in a process group of its own. On termination the loop sends SIGTERM to the group, waits up to `ORCH_WORKER_AGENT_STOP_MS` (default 10000; new optional `WorkerSettings.agentStopMs`), and sends SIGKILL; after a SIGKILL it waits for the exit only, not for the pipes.
  - After the agent's exit the steps are those of any launch. A launch still held (or whose status cannot be read) is committed, pushed (forced) and released with `{ workerId, reason: 'podTerminating', keep: true, headSha, wipCommit? }`. A failed commit is skipped; a failed push sends no release; nothing is retried; `push-failed` and `release-failed` exit 1.
  - After the request every API call retries connection failures for at most the smaller of `ORCH_RETRY_WINDOW_MS` and 5000 ms, a heartbeat in flight is awaited for at most 5 s, and the fallback relay's push is bounded at 30 s.
- `deploy/base/worker.yaml`: `terminationGracePeriodSeconds: 120`, no preStop hook. `deploy/README.md` "The workers" describes the termination.
- The daemon is not changed: `podTerminating` is the release's reason text, so `launch.released` and `carry.interrupted` carry it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `worker-pool`: ADDED "Pod termination".
- `cluster-runtime`: MODIFIED "Worker Deployment" (the grace period, no preStop hook).

## Impact

- New `src/worker/terminate.ts`; `src/worker/loop.ts`; `deploy/base/worker.yaml`; `deploy/README.md`.
- Tests: new `test/slice/worker-termination.test.ts`, `test/host/worker-termination.test.ts`, and the agent `test/agents/slow-agent.ts`.
