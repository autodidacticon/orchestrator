## Context

The repository is empty. The design was produced in a plan-mode conversation on 2026-10-12 that decomposed the problem into nine topics, decided five (graph model, task lifecycle, agent contract, workspace and integration, runtime), and deferred four (tracker sync, scheduling policy, health monitoring, graph mutation). An independent review then reproduced three defects in the first draft: duplicate agents after a daemon crash, an empty-diff submission passing verification, and a false stall report on chained milestones. The revised design below incorporates every finding. The full record, including the review table, is `plans/0-orchestrator-v1/plan.md`.

Constraints: one repository per orchestrator instance; agents are external processes (Claude Code first) that cannot receive pushes mid-tool-call; the orchestrator must survive a hard kill at any instant; humans are the only actors who can resolve underspecified or impossible tasks.

## Goals / Non-Goals

**Goals:**
- Run many coding agents in parallel from a task DAG, with dependencies controlling admission.
- Make "done" mean sealed, rebased, checked, and published, never merely claimed.
- Make every failure mode visible and attributable: failed, blocked, stalled with roots, waiting with open questions.
- Converge to the same outcome after a crash at any boundary, provable by a crash-injection suite.
- Keep the orchestrator static and deterministic, with named hook points where model judgment may be plugged in later.

**Non-Goals:**
- Tracker integration (Linear, Jira). Exporters will write the graph file later.
- Scheduling beyond FIFO with resumables first: no critical path, declared file scopes, or budgets.
- Health monitoring beyond leases and heartbeats: no progress signals or stuck diagnosis.
- Cascade invalidation on reopen, agent-proposed tasks, or multi-repository tasks.
- Judging task correctness. v1 checks acceptance evidence structurally and leaves judgment to gated milestones.

## Decisions

**Projection over pruning.** The graph is immutable per load and status lives in an overlay keyed by stable id. Alternatives: prune completed nodes (destructive, non-idempotent, cannot reconcile with an upstream file that changes, cannot express reopen). Projection makes `ready` a pure function and makes reload and crash recovery tractable.

**DAG vocabulary, milestones as nodes.** No root or leaf. A milestone is a node that does no work and completes when its closure is done; its closure is the subgraph it denotes. Alternatives: tags on tasks (cannot participate in the DAG), a synthetic root (unnecessary, since `finished` needs none). Gating is a per-milestone flag; most imported containers auto-complete.

**Cancelled dependencies are configurable per cancellation.** The person cancelling chooses `releasesDependents`; a global default of false is the safe setting. Alternatives: always block (too rigid), always release (builds on absent work), cascade cancel (surprising). The derived `stallRoots` includes dependents of unreleased cancellations so the stall stays diagnosable.

**Live peer over batch, batch as the fallback.** Agents speak a loopback HTTP API with an MCP façade. The one capability batch cannot give is in-process blocking with context intact. Alternatives: report file on exit only (simpler, loses that capability). Costs of live are paid down: durable deduplicated events for restart safety, a file fallback for reach, pull-based inbox because headless agents cannot take pushes, and waiting degrading to blocked on timeout.

**Launches distinct from attempts.** A launch is a process with its own token, branch, and worktree. An attempt is the failure budget. Daemon-caused relaunches and integration conflicts spend launches, not attempts. Alternative: one counter (conflates "the task is impossible" with "the daemon restarted").

**The agent commits, the orchestrator seals.** `report submit` is rejected with 409 on a dirty worktree, the head is recorded as `sealedSha`, and later commits are ignored. Alternatives: auto-commit on behalf of the agent (hides sloppiness, captures junk), trust the branch at verification time (racy). Empty diffs must be declared; acceptance evidence is checked structurally.

**Orchestrator as merge queue.** The verifier rebases, checks, squashes with trailers, and publishes by compare-and-swap. Alternatives: agents merge their own PRs (puts the most error-prone step with the least trustworthy actor), humans merge (throughput bounded by reviewers). Human review becomes a verifier flag between green and merge, not a different design.

**Conflicts retry with context under a separate cap.** The next launch's brief names the files, the siblings that landed, and the old branch. Alternatives: a resolver agent now (a second agent kind to specify), immediate human escalation (stalls on every collision). The resolver is the designated hook later.

**Resume requires admission.** The answer is persisted first, then the scheduler admits the resumable task, resumables before new launches. Alternative: resume immediately on answer (exceeds capacity, as the review showed).

**Milestone rejection goes to blocked.** Never retried automatically. Repair is an upstream edit plus unblock, and resubmission is a new review version at a new pinned sha. Alternative: treat as failed (the generic retry resubmits the unchanged milestone forever).

**Adoption over tethering.** Agents are spawned detached with logs to files and are adopted after a daemon restart. Only the unconfirmable spawn window is revoked and killed by launch id. Alternative: a wrapper that kills agents when the daemon dies (every restart costs every in-flight launch).

**Compatible-edit rules over a frozen graph.** Adding nodes and editing not-yet-started nodes is accepted; editing or removing started nodes rejects the reload whole; every launch pins its graph revision. Alternative: freeze per run (simplest, but adding a follow-up task would require stopping the run).

**Milestone completion to a fixed point, stall property on quiescent reachable states.** Alternative: a single pass (leaves chained milestones due and reports a false stall).

**Brief validation with configurable remediation, review by default.** A template declares slots; insufficient tickets block or go to a planning-model hook. Review mode is the default because a model that invents acceptance criteria produces work that passes its own tests: confidently wrong and green.

**Direct dependencies' reports only.** The brief carries each direct dependency's completion report. Alternatives: the transitive closure (unbounded, mostly noise), nothing (every agent re-derives upstream decisions from diffs).

**SQLite via better-sqlite3.** One file, WAL mode, synchronous API so a claim or a dedup write is one transaction. Alternatives: JSON files (no atomic claims), Postgres (operational weight for a single-process daemon).

**TypeScript on Node 22, ESM.** Closest to the Claude Code and MCP ecosystem. Alternatives considered: Python (fastest iteration, stronger property testing), Go (best daemon shape, slowest to iterate on a moving design).

**File graph source with external exporters.** The daemon reads one JSON or YAML file; tracker adapters are separate programs that write it. Alternative: adapters inside the daemon (their rate limits and auth become the daemon's problem, and every test needs a fake tracker).

**Static orchestrator with named hook points.** The loop is a reconciliation controller; model judgment is confined to brief remediation (shipped as an interface), conflict resolution, failure triage, and acceptance review, each defaulting to blocking for a human. Alternative: an agent as orchestrator (non-deterministic, untestable, expensive).

**Done is not accepted.** `done` means integrated. Acceptance criteria are required in the brief, evidence is checked structurally, and gated milestones are where a human judges correctness. An acceptance-review hook is deferred.

## Risks / Trade-offs

- [Model-remediated briefs produce confidently wrong, green work] → review mode by default; acceptance evidence required; gated milestones for human judgment.
- [Orphan agents after an unconfirmable spawn keep consuming compute] → token revocation, kill by launch id, periodic sweeps, isolated branches and worktrees so they cannot affect correctness.
- [Logically independent tasks collide at merge] → rebase-and-retry with context under a separate cap; declared file scopes are a later scheduling feature.
- [Slow human answers hold parked processes] → waiting tasks hold no run slot, `maxWaiting` bounds them, `maxWait` degrades to blocked without losing the question.
- [A server inside the daemon widens the surface] → loopback only, per-launch bearer tokens, every mutating call deduplicated.
- [Flaky check commands burn the failure budget] → timeout, output attached to the next brief, attempts configurable.
- [Daemon restart during a long-poll] → the answer is stored; the agent replays `block` with the same seq.
- [Whole-reload rejection surprises an operator editing the graph] → `graphRejected` reasons in status; cancel-then-remove is the documented path.
- [Human-entered dependency relations form cycles upstream] → validation on load reports the cycle path and keeps the previous snapshot.
- [Large dependency closures bloat briefs] → direct dependencies only, with a pointer to the log.
- [Foreign commits on the integration branch bypass the pipeline] → the primary clone keeps the branch checked out so worktrees cannot, and a sweep flags commits without trailers.

## Migration Plan

Greenfield; nothing to migrate. Rollback is deleting the daemon's SQLite file, worktrees, and `task/*` branches; the integration branch is only ever advanced by trailer commits that can be reverted individually.

## Open Questions

- Tracker sync: should status and remediated briefs be written back to the tracker, and by whom?
- Scheduling: when to add critical-path ordering, declared file scopes for conflict prediction, milestone priority, and cost budgets.
- Health: progress signals, stuck detection, cost ceilings, the stuck-diagnosis hook, and the `baseMoved` notice.
- Graph mutation: cascade invalidation on reopen, whether automatic milestones should be transparent to the reopen guard, and agent-proposed tasks with approval.
- Hooks: when conflict resolution, failure triage, and acceptance review get model-backed implementations.
