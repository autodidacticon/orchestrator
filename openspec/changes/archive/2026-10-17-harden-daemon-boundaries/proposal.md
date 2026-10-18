## Why

During the first unattended run both daemons on the machine received a reaping shutdown fifteen seconds apart, from no session. The most likely source was an agent working on daemon shutdown that could see every run under the default `ORCH_HOME`, because spawned agents and check commands inherit the daemon's whole environment. The shutdown route recorded nothing about its caller, so the attribution is a guess. Two small boundaries fix both: agents and checks get an isolated `ORCH_HOME` and no client-side daemon variables, and every shutdown request records who asked.

## What Changes

- Spawned agents and check commands run with `ORCH_HOME` set to a directory inside the run's data directory (`<dataDir>/child-home`) and with `ORCH_URL`, `ORCH_REPO`, and `ORCH_DATA_DIR` removed, so an `orchestrator-ctl` or lifecycle call they make sees no real daemon and can start none in the user's home. The agent-facing variables (`ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_TASK_ID`, `ORCH_WORKTREE`) are unchanged.
- `POST /v1/shutdown` records its caller: the `x-orch-attachment` header when present, the remote address, and the user agent, in an `operator.shutdown` event and in the exit record's new `by` field; `runs` shows it.
- Specs: `agent-protocol` gains an "Agent environment" requirement, `integration-pipeline` a "Check environment" requirement, and `operator-control` modifies "Shutdown" and "Exit record".

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `agent-protocol`: ADDED `Agent environment`.
- `integration-pipeline`: ADDED `Check environment`.
- `operator-control`: `Shutdown` records the caller; `Exit record` carries `by`.

## Impact

- Code: new `src/runs/childEnv.ts`; `src/loop/orchestrator.ts` (`agentEnv`), `src/verify/verifier.ts` (`runCheck` env), `src/operator/routes.ts` (shutdown route), `src/main.ts` and `src/runs/runDir.ts` (exit record), `src/runs/lifecycle.ts` (`runs` output), tests in `test/slice`.
- Behaviour: an agent that runs `orchestrator-ctl runs` sees an empty list; a check command cannot reach the user's run directories. The daemon's own operator routes stay reachable from an agent through `ORCH_API`, as they must be for the shim; authentication for them is ORC-34 in the cloud plan.
- Not in scope: operator route authentication; the reap-on-report usage loss.
