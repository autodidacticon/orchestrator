## Why

The lease is renewed only by an agent's own API calls, and nothing heartbeats automatically: `renewLease` in `src/loop/orchestrator.ts` runs at the top of `agentCall` and nowhere else, and the MCP shim exposes `heartbeat` as a tool the agent may never pick. A Claude Code agent that edits silently for longer than `leaseTtlMs` (default ten minutes) is reaped by the reconcile phase while alive and productive, the task becomes `failed` with reason `leaseExpired`, and that false failure spends an attempt. The real-agent runs never hit it because every task finished in under two minutes. A daemon outage longer than the TTL fails every surviving agent the same way on the first tick after adoption. There is also no stuck detection, no cost or wall-time budget, and no notice to an agent when a sibling lands on the integration branch. Conversation 7 (2026-10-12, `plans/3-health/plan.md`) settled the design.

## What Changes

- Liveness replaces silence as the failure signal. The daemon checks process liveness every tick and renews the lease while the process is alive. Lease expiry remains only for launches whose runner cannot observe the process, the split the pending `add-pull-runner` change relies on.
- Progress signals: a cheap worktree fingerprint (head sha plus a hash of `git status --porcelain` and `git diff HEAD`), any agent API call, and a changed heartbeat text record `progressAt` and `lastSignal` on the launch row.
- Stuck detection with escalation: flag after `health.stuckAfterMs`, queue a `stuck` inbox notice, fail with reason `stuck` after `health.stuckFailAfterMs`. A `StuckDiagnoser` hook with the remediation hook's shape, default human.
- Operator `nudge <task> <message>` as a route, a CLI command, and an MCP tool; it queues a `nudge` inbox notice.
- Budgets: `budgets.maxLaunchMs` kills an overlong launch with reason `timeBudget`; `budgets.maxRunCostUsd` pauses admission with `pausedReason: 'costBudget'`, and `resume` needs `overrideBudget` while over the ceiling. Cost comes from a runner-specific usage parser over the launch log.
- A `baseMoved` inbox notice to every live sibling when a task is published, listing the files the commit touched. The brief allows rebasing the launch branch onto the integration head, and the verifier rebases from the merge base so such branches verify.
- Status, the digest, and `wait` expose stuck tasks, the pause reason, cost, budgets, and per-launch health; the run skill surfaces stuck tasks and budget pauses.

## Capabilities

### New Capabilities
- `health-monitoring`: process liveness, progress signals, stuck detection and escalation, the diagnosis hook, the launch time budget, usage accounting, the run cost budget, and the base-moved notice.

### Modified Capabilities
- `task-lifecycle`: the lease requirement changes meaning (the daemon renews by liveness; expiry only for unobserved launches); new failure reasons `stuck` and `timeBudget` that spend an attempt.
- `agent-protocol`: inbox notices `stuck`, `nudge`, and `baseMoved`, and the brief wording about notices and rebasing.
- `integration-pipeline`: the verifier rebases from the merge base of the integration head and `sealedSha`.
- `operator-control`: the `nudge` operation, health facts in the status report, and the budget pause with its override on `resume`.
- `operator-mcp`: the `nudge` tool, `overrideBudget` on `resume`, and the digest's `stuck` and `pausedReason` fields.
- `host-integration`: the run skill handles stuck tasks and budget pauses.

## Impact

- `src/config.ts` gains `health` and `budgets` blocks. The reconcile phase in `src/loop/tick.ts` gains liveness renewal and the progress, stuck, and time-budget checks; `drainVerification` queues `baseMoved`; `admitAndLaunch` enforces the cost ceiling. `src/loop/orchestrator.ts` records API-call progress, adds `nudge`, refuses `resume` over budget, and extends `StatusReport`.
- New `src/health/{progress,stuck,budgets}.ts`. `AgentRunner` gains `liveness` and `readUsage`; `Workspace` gains `fingerprint`; the verifier's published outcome carries `changedFiles`; launch rows gain health and usage fields (JSON documents, no schema migration); `FailedKind` gains `stuck` and `timeBudget`.
- Operator surfaces: `POST /v1/tasks/:id/nudge`, `orchestrator-ctl nudge` and `resume --override-budget`, the MCP tool `nudge`, two `digestOf` fields, and `hosts/claude-code/skills/run/SKILL.md`.
- Tests that relied on lease expiry for a hung process switch to a runner reporting `unknown` liveness. Cost accounting is blind to launches killed before `claude -p` prints its final JSON; live cost through `stream-json` is deferred.
