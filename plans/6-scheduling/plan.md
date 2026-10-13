# Scheduling policy: plan for change `add-scheduling-policy`

## Context

v1 admits ready tasks first-in first-out in graph file order, resumables first, up to
capacity (`src/loop/schedule.ts`, called from `admitAndLaunch` in `src/loop/tick.ts`). The
`Policy` interface has `filter` and `order` hooks that v1 left as identities. Three gaps
show up once real epics are imported: nothing prefers the chain that gates the milestone,
nothing honours the priority the tracker puts on every issue, and two tasks that edit the
same files run side by side until one conflicts at integration and spends a retry.
Conversation 5 on 2026-10-12 settled the fix. This document records the decisions and
their reasoning; the OpenSpec change `add-scheduling-policy` holds the requirements, design
record, and task checklist. It is the fifth and smallest of the active changes and lands
after `add-pull-runner`, whose claimable launches hold capacity slots and so hold scopes.

## Decisions

1. **A configurable chain, critical path first by default.** `scheduling.order` lists
   stages applied as one stable lexicographic sort over ready candidates; default
   `['criticalPath', 'priority', 'fifo']`. Resumables are admitted first and are not in
   the chain. An unknown stage name fails config validation. Rejected: keep FIFO, because
   the longest chain sets the run's wall time and FIFO starts it wherever the file lists
   it. Rejected: priority first, because an urgent leaf can starve the gating chain.
2. **`criticalPath` counts task nodes only.** The length of the longest chain of dependents
   below a node, milestones and external nodes passed through at zero, computed once per
   graph revision and cached with the graph. Longer first. It lives in `src/graph/query.ts`
   as a pure query and is specified under `task-graph`.
3. **`priority` is a number, lower first, missing last.** The stage reads `payload.priority`.
   The import passes the tracker's value through unchanged except Linear's 0, which means
   no priority and becomes absent. The import skill tells the session to send a numeric rank.
4. **Scopes are optional and the overlap rule is conservative.** A task may carry
   `scope: string[]` of path globs, from the graph file or from a `Scope` heading in an
   imported description parsed with the criteria splitter. The static prefix of a glob is
   its longest leading run of segments without `*`, `?`, `[`, `{`; two globs overlap iff one
   static prefix is a path-prefix of the other or they are equal; an empty prefix (`**`,
   bare `*`) overlaps everything. Decidable, no glob library, errs toward deferring.
   Rejected: no scopes, relying on rebase and the conflict retry, which costs a launch each.
5. **The filter checks held tasks and this pass's admissions.** Held means running,
   waiting, submitted, or holding a claimable launch. Admission walks the ordered list and skips any
   candidate overlapping a held task or one admitted earlier in the pass, so two
   overlapping ready siblings launch one at a time. Submitted tasks hold their scope until published, because a sibling starting from the older base during verification is guaranteed to conflict.
6. **Deferrals are reported, not evented.** Status gains
   `deferred: [{ id, reason: 'scopeOverlap', with }]` from the last admission pass and the
   digest gains a `deferred` count, so a run that looks stalled is explainable. No event,
   because one would fire every tick while the blocker runs.
7. **Placement.** `src/loop/schedule.ts` holds the stage registry, `chainPolicy(config)`,
   the overlap function, and `deferred` in the admission result; `src/config.ts` gains
   `scheduling: { order, scopes }`. `scopeHeading` sits beside `criteriaHeading` in the
   import options, because the mapping runs in the MCP server process, which never reads
   the daemon config. A malformed `scope` fails graph validation. No new routes or tools.

## Implementation

Six task groups in `openspec/changes/add-scheduling-policy/tasks.md`:

1. Critical path query (`criticalPathLength` in `src/graph/query.ts`, fixture and property
   tests).
2. Ordering chain (`scheduling` config, the stage registry, `chainPolicy`, the orchestrator
   default, config validation).
3. Scopes and the overlap filter (`scope` on the node schema, `staticPrefix` and
   `scopesOverlap`, `held` in the context, `conflicts` on the policy, the walk in `admit`,
   the held set built in the tick).
4. Deferred reporting (`deferred` in `StatusReport` and `digestOf`, tool descriptions, the
   run skill).
5. Import (`scopeHeading`, the multi-heading splitter, priority normalisation, the import
   skill).
6. Properties and verification (the reachable-state stall property with scopes, README,
   the full suite).

Gate: group 3's scenario tests plus group 6's property run. Groups 1 and 2 can land first.
Groups 3 and 4 go together, because a deferral without `deferred` in status looks like a hang.

## Verification

- `npm test` green, including the crash suite and the scripted end to end, which do not
  change.
- Unit: critical path lengths on the standard fixture (T1 2, T2 1, the rest 0); length is
  monotone along deps and ignores milestones; the overlap rule table; stable chain ordering
  with ties falling through to file order; priority normalisation including Linear's 0;
  config validation rejecting an unknown stage.
- Scenario: an overlapping candidate is skipped while its blocker runs and admitted when
  the blocker is published; waiting, submitted, and claimable blockers defer; `deferred` appears in
  status and the digest; an imported description with a `Scope` heading yields a scope.
- Property: the reachable-state stall property holds with the default chain and scopes on.
- Manual: `orchestrator-ctl status` on two overlapping ready tasks shows one running and the
  other deferred with the blocker's id.

## Deferred

- Learning scopes from a finished launch's diff for relaunches and dependents.
- A budgets filter stage from `add-health-monitoring` in the same registry.
- Estimate-weighted critical paths, if trackers supply estimates.
