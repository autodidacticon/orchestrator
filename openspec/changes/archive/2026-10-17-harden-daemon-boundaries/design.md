## Context

`SubprocessRunner.spawn` merges `process.env`, `extraEnv`, and `agentEnv(launch)` (`ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API`, `ORCH_TASK_ID`, `ORCH_WORKTREE`), deleting keys whose value is the empty string. `runCheck` in `src/verify/verifier.ts` spawns `/bin/sh -c <checkCommand>` with `process.env` plus the git identity. The CLI, the lifecycle, and the launcher resolve runs from `ORCH_HOME` (default `~/.orchestrator`), `ORCH_URL`, `ORCH_REPO`, and `ORCH_DATA_DIR`. `POST /v1/shutdown` calls `requestShutdown('stop', reap)` and the exit record is `{ at, reason, reap, digest }`. The operator MCP server sends `x-orch-attachment` on every request.

## Goals / Non-Goals

**Goals:** a child process of the daemon cannot discover or stop any real daemon through the run directory layout; every shutdown is attributable after the fact.

**Non-Goals:** authenticating operator routes (ORC-34); preventing an agent from calling its own daemon's routes through `ORCH_API`, which the shim needs; sandboxing the filesystem.

## Decisions

**Isolate by environment, in one helper.** `childEnv(dataDir, extra)` returns `process.env` with `ORCH_HOME` set to `<dataDir>/child-home` and `ORCH_URL`, `ORCH_REPO`, `ORCH_DATA_DIR` set to the empty string (the runner's existing delete-on-empty rule removes them; the verifier applies the same rule). Both the runner and the verifier use it, so the two spawn sites cannot drift. The directory is created lazily by whatever child uses it; nothing in the daemon reads it. Rejected: an allowlist of environment variables, which is ORC-29's cluster-scale job and would break toolchains that rely on arbitrary variables today.

**The daemon's own API stays reachable.** `ORCH_API` is how the shim reports, blocks, and heartbeats. Removing it would break every agent; authenticating the operator routes is a separate change. The isolation closes cross-run discovery, which is what the incident needed.

**Attribution at the route, recorded twice.** The shutdown handler reads `x-orch-attachment`, `req.socket.remoteAddress`, and `user-agent`, appends `operator.shutdown { reap, by }` before scheduling the stop, and passes `by` into `requestShutdown` so the exit record carries it. Two records because the event log is the durable history and the exit record is what `runs` and the revival refusal show without opening the store. Rejected: attributing only by attachment id, which is absent for the CLI and any raw HTTP client.

## Risks / Trade-offs

- [A project's check command legitimately needs `ORCH_HOME`] → none does today; the variable is the orchestrator's own. A check that runs the orchestrator's own tests (this repository) gets an isolated home, which is correct: the suite creates its own.
- [Attribution is advisory] → a caller can omit the header and the remote address is loopback for every local client; the record still separates the CLI, the MCP server, and an unknown client, which is what the incident lacked.
