## Why

Admission is first-in first-out in graph file order. Nothing prefers the chain that gates the milestone, so the longest chain can start last and set the run's wall time. Nothing honours the priority the tracker already carries on every imported issue. And two tasks that edit the same files run side by side, then one of them conflicts at integration and spends a retry. Conversation 5 (2026-10-12, `plans/6-scheduling/plan.md`) settled the fix: a configurable ordering chain with critical path first, optional declared file scopes with a conservative overlap filter, and deferred candidates reported in status so a run that looks stalled is explainable.

## What Changes

- Add a configurable ordering chain, `scheduling.order`, applied as one stable lexicographic sort over ready candidates. Default `['criticalPath', 'priority', 'fifo']`. Resumable waiting tasks are still admitted first and are not ordered by the chain. An unknown stage name fails config validation.
- Add a critical path query to the graph module: the longest chain of task dependents below each node, milestones and external nodes passed through at zero, computed once per graph revision and cached.
- Read tracker priority from the task payload as a number where a lower number is more urgent and a missing value sorts last. The import passes priority through unchanged except that Linear's 0, which means no priority, becomes absent.
- Let a task declare `scope`, a list of path globs, in the graph file or under a `Scope` heading in an imported description, parsed with the same splitter as acceptance criteria. A malformed scope fails graph validation.
- Add a scope filter at admission, `scheduling.scopes` default on: a candidate is skipped this tick when its scope overlaps the scope of a task that is running, waiting, submitted, or holds a claimable launch, or of a candidate admitted earlier in the same pass. Overlap is decided on static glob prefixes.
- Report skipped candidates as `deferred: [{ id, reason: 'scopeOverlap', with }]` in status and as a `deferred` count in the digest.

## Capabilities

### New Capabilities
- `scheduling-policy`: the stage chain and each stage's definition, resumables first, the scope declaration, the overlap rule, and the filter at admission.

### Modified Capabilities
- `task-graph`: adds the critical path length query.
- `graph-import`: adds priority normalisation and the `Scope` heading.
- `operator-control`: adds `deferred` to the status report and the digest.

## Impact

- `src/loop/schedule.ts` gains the stage registry, `chainPolicy(config)`, the overlap function, and `deferred` in the admission result; `src/loop/tick.ts` passes the held set; `src/graph/query.ts` gains `criticalPathLength`; `src/graph/load.ts` validates `scope`; `src/config.ts` gains `scheduling`; `src/import/mapping.ts` gains `scopeHeading` and priority normalisation; `StatusReport` and `digestOf` gain `deferred`.
- No new routes, tools, events, or store tables. The default admission order changes from FIFO to the chain; `order: ['fifo']` and `scopes: false` restore v1 behaviour exactly.
- The pending `add-pull-runner` change introduces claimable launches that hold capacity slots. The held set treats them like running tasks, so that change contributes one line to the tick.
- Graph files without `scope` and descriptions without a `Scope` heading are unaffected.
