## Why

`budgets.maxRunCostUsd` sums only launches that recorded a cost. A launch that ended with no usage at all is in no count: every launch worked by a Claude Code session subagent, every scripted launch, and any command agent that prints no usage. A run can sit under its budget while most of its cost is unknown, and nothing says so (GH-195).

## What Changes

- `src/health/budgets.ts`: new `unmeteredLaunches(store)`, the count of launch rows that are `ended` or `revoked`, had an agent (`worker` or `spawnedAt` set), and hold no usage (no cost, turns, duration or tokens). It never overlaps `unpricedLaunches`, and it falls when a worker posts usage for an ended launch.
- `src/loop/orchestrator.ts`: `status.cost.unmeteredLaunches`.
- `src/operator/routes.ts`: the digest's `unmeteredLaunches`, 0 without a graph. The status body without a graph still has no `cost`.
- No event and no budget change: unmetered launches never pause admission.
- The three run skills: a new paragraph after the configuration-keys paragraph, the `costBudget` bullet names the count, and the Claude Code edition's section 1a says this session's subagents record no usage.
- `README.md`: the "Health." paragraph names `cost.unmeteredLaunches`.

Specs (MODIFIED: none):

- health-monitoring: ADDED "Usage accounting: unmetered launches".
- operator-control: ADDED "Status report: unmetered launches".
- operator-mcp: ADDED "Wait digest: unmeteredLaunches".
- host-integration: ADDED "Run skill names unmetered launches".

## Impact

- `src/health/budgets.ts`, `src/loop/orchestrator.ts`, `src/operator/routes.ts`
- `hosts/*/skills/run/SKILL.md`, `README.md`
- `test/loop/unmetered.test.ts`, `test/loop/health.test.ts`, `test/host/unmetered-skill.test.ts`
