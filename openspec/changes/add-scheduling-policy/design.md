## Context

Admission lives in `admitAndLaunch` in `src/loop/tick.ts`, which calls `admit(resumables, ready, ctx, policy)` from `src/loop/schedule.ts`. The `Policy` interface already has `filter` and `order` hooks, both identity in v1, and `ready` returns tasks in graph file order. Imported payloads carry `priority` and `labels`, and `splitDescription` in `src/import/mapping.ts` parses one configurable heading. The pending `add-pull-runner` change adds claimable launches that hold a capacity slot before a process exists. Constraints: the policy stays pure and runs once per tick; the reachable-state stall property must keep holding; no new routes or tools.

## Goals / Non-Goals

**Goals:**
- Start the chain that gates the milestone first by default, and let a team change the order in config.
- Use tracker priority as a tie-breaker without letting it starve the critical path.
- Keep tasks with overlapping declared file scopes from running at the same time, and make every deferral explainable from status.
- Keep the policy pure, per tick, and testable without a daemon.

**Non-Goals:**
- Inferring scopes from diffs or history.
- Full glob semantics; the overlap rule is conservative on purpose.
- Preemption. A running task is never stopped to make room.
- Estimates or cost-weighted critical paths.

## Decisions

**A configurable stage chain, critical path first by default.** `scheduling.order` names stages; the policy builds one comparator per stage and applies them as one stable lexicographic sort, so a later stage only breaks ties left by the earlier ones. Rejected: keep FIFO and defer the change, because the longest chain sets the run's wall time and FIFO starts it wherever the file happens to list it. Rejected: tracker priority first, because an urgent leaf with no dependents can push the chain that gates the milestone behind it; priority stays as the second stage, and a team that wants it first changes the list.

**Critical path counts task nodes only, per graph revision.** Length is the number of tasks on the longest chain of dependents below a node; milestones and external nodes are passed through at zero, so a chain continues through a milestone. It is computed from the graph alone and cached with the graph object, which is immutable per revision. Rejected: weighting by estimates, because payloads carry none. Rejected: discounting done dependents, because nothing below a ready task can be done.

**Priority is a number, lower first, missing last; the import does not interpret it.** Linear and Jira both expose a numeric rank in the session, and the import skill tells the session to send it. The one exception is Linear's 0, which means no priority and becomes absent. Rejected: mapping tracker priority names to a scale in code, which would put tracker knowledge into the mapping that the session already has.

**Scopes are optional, declared, and conservative.** A task may list path globs; the filter skips a candidate while any task holding a slot overlaps it. Rejected: no scopes, relying on rebase and the conflict retry, because each conflict costs a whole launch and the retry cap is three. Rejected: inferring scopes from the diff of an earlier launch, because the first launch has none; it is an open question.

**Overlap is decided on static glob prefixes.** The static prefix is the longest leading run of path segments containing none of `*`, `?`, `[`, `{`. Two globs overlap iff one static prefix is a path-prefix of the other or they are equal, and an empty prefix (`**`, bare `*`) overlaps everything. This is decidable, needs no glob library in the core, and errs toward deferring. Rejected: full glob intersection, which is not decidable in general with braces and negation. Rejected: exact match only, which misses `src/**` against `src/api/x.ts`.

**Admission walks the ordered list and checks each candidate against held tasks and this pass's admissions.** The held set is tasks that are `running`, `waiting`, or `submitted` plus tasks with a claimable launch, built in the tick and passed in the context. `Policy` gains `conflicts(candidate, held, ctx)` returning the overlapping ids, and `admit` records each skipped candidate in `deferred`. Rejected: a `filter` against held tasks only, because two overlapping ready siblings would both launch on the first tick, which is the motivating failure. Submitted tasks hold their scope until their work is published, because a sibling that starts from the older base during verification is guaranteed to conflict with it.

**Deferrals are reported, not evented.** The orchestrator keeps the last pass's `deferred` list, `status` reports it with the blocking ids, and the digest carries the count. Rejected: an event per deferral, which would fire every tick while the blocker runs.

**A malformed scope fails graph validation.** A string where a list is expected would otherwise silently unconstrain the task. The loader declares `scope` on the node schema; it still lands in the payload.

**`scopeHeading` sits beside `criteriaHeading` in the import options.** The mapping runs in the operator MCP server process, which never reads the daemon config, and the session already passes `criteriaHeading` the same way. `scheduling.order` and `scheduling.scopes` are daemon config because the tick reads them.

## Risks / Trade-offs

- [Conservative overlap defers tasks that would not conflict, such as `src/api-*/**` against `src/ui/**`] → the run still completes, one task at a time; longer static prefixes tighten it; `scheduling.scopes: false` turns it off.
- [Scopes missing or wrong] → behaviour is exactly v1: rebase, then the conflict retry.
- [A waiting blocker holds its scope while its question is open] → `maxWait` degrades it to blocked, which releases the scope; meanwhile status names it in `with`.
- [Critical path ignores effort] → a chain of small tasks outranks one large task; priority is the override and the order is configurable.
- [Holding a scope through verification delays an overlapping sibling by one verifier job] → the verifier is serial and usually fast, and the delay is visible as `deferred` naming the submitted blocker.
- [The default order change surprises existing tests] → scenarios that assumed file order are reviewed; `order: ['fifo']` reproduces v1.

## Migration Plan

No store or route changes. The default admission order changes from FIFO to the chain; `scheduling: { order: ['fifo'], scopes: false }` restores v1 exactly. Graph files without `scope` and descriptions without a `Scope` heading behave as before. `fifoPolicy` stays exported for tests that pass a policy explicitly.

## Open Questions

- Whether the diff of a finished launch should seed scopes for relaunches and dependents.
- Whether health budgets from `add-health-monitoring` become a `filter` stage in the same registry.
