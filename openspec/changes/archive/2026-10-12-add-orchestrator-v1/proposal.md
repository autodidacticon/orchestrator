## Why

Coding agents can work in parallel, but nothing reliably drives many of them from a dependency graph of tasks against one repository. Dependencies must gate admission, humans must be able to resolve blockers and review milestones, and "done" must mean the work was verified and integrated rather than claimed. The design was settled and reviewed on 2026-10-12 (see `plans/0-orchestrator-v1/plan.md`). This change turns it into requirements, a design record, and an implementation checklist.

## What Changes

- Introduce a task graph model: an immutable DAG of tasks and milestones with a status overlay, a derived ready frontier, milestone completion to a fixed point, stall detection, and validated reloads pinned to graph revisions.
- Introduce a task lifecycle: explicit states (`unstarted`, `running`, `waiting`, `submitted`, `done`, `failed`, `blocked`, `cancelled`), a transition table by actor, three distinct counters (launches, attempts, integration retries), leases, retry, a reopen guard, and cancellation with optional release of dependents.
- Introduce an agent protocol: a standalone brief, a loopback HTTP API with an MCP façade, deduplicated events, sealed submissions, declared no-ops, acceptance evidence, in-process blocking with scheduler-admitted resume, a file fallback, and token fencing.
- Introduce an integration pipeline: one worktree per launch, a serialized verifier that rebases, checks, squashes with trailers, and publishes with a compare-and-swap ref update, conflict retry under a separate cap, and milestone tagging at a pinned sha.
- Introduce crash recovery: durable records around every external effect, per-boundary recovery, adoption of surviving agents, revocation of unconfirmable launches, sweeps, named crash points, and convergence invariants proven by a crash-injection suite.
- Introduce operator control: an HTTP-backed CLI for status, answers, cancellation, reopen, milestone review, pause and resume, logs, and shutdown, where every human action is an event.
- Establish the runtime: one TypeScript daemon on Node 22, a SQLite store, and a file-based graph source that tracker exporters write.

## Capabilities

### New Capabilities
- `task-graph`: loading, validating, and querying the dependency graph; readiness, milestones, stall detection, graph revisions, and reload compatibility.
- `task-lifecycle`: node states, allowed transitions by actor, admission, counters, leases, retry, the reopen guard, cancellation, and milestone review.
- `agent-protocol`: what an agent receives and how it reports, including deduplication, sealing, no-op and acceptance checks, blocking and resume, fallback, fencing, the MCP façade, and brief validation.
- `integration-pipeline`: repository layout, workspaces per launch, the verifier job pipeline, publication, conflicts, foreign-commit detection, and milestone tags.
- `crash-recovery`: durable record bracketing, recovery per boundary, adoption, fencing, sweeps, crash points, and convergence invariants.
- `operator-control`: operator commands and their events, the status report, pause and resume, shutdown, and logs.

### Modified Capabilities
- None. This is a greenfield project and `openspec/specs/` is empty.

## Impact

- New codebase under `src/` and `test/`: TypeScript, Node 22+, ESM, npm.
- New runtime dependencies: `better-sqlite3`, `zod`, `yaml`, `@modelcontextprotocol/sdk`. Dev: `vitest`, `fast-check`, `tsx`, `typescript`.
- New local artifacts per run: one SQLite database, git worktrees and `task/<id>/l<n>` branches, `milestone/<id>/v<n>` tags, and per-launch log files.
- Requires git and, for real runs, a headless coding agent such as Claude Code. Tracker integrations (Linear, Jira) are out of scope for this change and will be exporters that write the graph file.
