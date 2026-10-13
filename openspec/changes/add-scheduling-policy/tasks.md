## 1. Critical path query

- [ ] 1.1 Add `criticalPathLength(graph): ReadonlyMap<Id, number>` to `src/graph/query.ts`: memoised walk over `graph.dependents`, a task dependent counts one, milestones and external nodes pass through at zero, the result cached per graph object in a `WeakMap`
- [ ] 1.2 Export `criticalPathLength` from `src/index.ts`
- [ ] 1.3 Tests: `test/graph/query.test.ts` standard fixture lengths (T1 2, T2 1, T3 0, T4 0, T5 0, MVP 0) and a milestone passed through to a task below it; `test/graph/properties.test.ts` over `dagArb`: length is monotone along deps (a dependency's length is at least its dependent's, plus one when the dependent is a task) and a milestone's length equals the maximum over its dependents

## 2. Ordering chain

- [ ] 2.1 `src/config.ts`: add `scheduling: { order: stage[], scopes: boolean }` with defaults `['criticalPath', 'priority', 'fifo']` and `true`; stage names as a zod enum so an unknown name fails parse naming it
- [ ] 2.2 `src/loop/schedule.ts`: stage registry with `criticalPath` (longer first, from `criticalPathLength`), `priority` (lower number first; absent or non-numeric last), and `fifo` (graph file order); each stage builds its comparator once per pass from the context
- [ ] 2.3 `src/loop/schedule.ts`: `chainPolicy(config): Policy` applying the configured stages as one stable lexicographic comparator; `fifoPolicy` stays as the trivial chain
- [ ] 2.4 `src/loop/orchestrator.ts`: default `policy` to `chainPolicy(config)` instead of `fifoPolicy`; export `chainPolicy` from `src/index.ts`
- [ ] 2.5 Tests: new `test/loop/schedule.test.ts`: the default chain orders the fixture's ready set T1 before T5 and T2 before T3; equal critical path falls through to priority and then to file order; a missing priority sorts last; `order: ['fifo']` reproduces v1 order; `defaultConfig` rejects `order: ['nope']` naming it; `test/loop/scenarios.test.ts` stays green with the default chain

## 3. Scopes and the overlap filter

- [ ] 3.1 `src/graph/load.ts`: declare `scope` on the node schema as an optional array of non-empty strings so a malformed value fails with code `schema` naming the node; it remains in `payload`
- [ ] 3.2 `src/loop/schedule.ts`: `staticPrefix(glob): string[]` and `scopesOverlap(a, b): boolean` per the overlap rule; `scopeOf(node): string[] | undefined` treating absent and empty as unconstrained
- [ ] 3.3 `src/loop/schedule.ts`: `ScheduleContext` gains `held: Id[]`; `Policy` gains `conflicts(candidate, held, ctx): Id[]`; `fifoPolicy.conflicts` returns nothing; `chainPolicy` returns the overlapping held ids, or nothing when `scheduling.scopes` is false
- [ ] 3.4 `src/loop/schedule.ts`: `admit` orders, then walks the ordered list admitting up to free capacity and recording each candidate that overlaps a held id or an id admitted earlier in the pass as `{ id, reason: 'scopeOverlap', with }`; `Admission` gains `deferred`
- [ ] 3.5 `src/loop/tick.ts` `admitAndLaunch`: build `held` from the overlay's running, waiting, and submitted tasks, plus tasks with a claimable launch once `add-pull-runner` lands; pass it in the context; hand `admission.deferred` to the orchestrator
- [ ] 3.6 Tests: `test/loop/schedule.test.ts` overlap table (equal globs, prefix, disjoint siblings, `**`, bare `*`, brace in a segment, star in a segment, a literal file against a directory glob); `test/graph/load.test.ts`: a string `scope` is rejected naming the node
- [ ] 3.7 Tests: `test/loop/scenarios.test.ts`: an overlapping candidate is skipped while the blocker runs and launched on the first tick after the blocker is published; two overlapping ready siblings launch one at a time; a waiting blocker, a submitted blocker, and a claimable launch all defer; `scopes: false` launches both

## 4. Deferred reporting

- [ ] 4.1 `src/loop/orchestrator.ts`: keep the last admission pass's `deferred` list; add `deferred` to `StatusReport` and `status()`; a paused run reports an empty list
- [ ] 4.2 `src/operator/routes.ts` `digestOf`: add `deferred` as a count
- [ ] 4.3 `src/operator/mcp-server.ts`: mention deferred candidates in the `status` and `wait` tool descriptions; `hosts/claude-code/skills/run/SKILL.md`: when the digest shows deferred candidates, name them and their blockers in the progress report instead of calling the run slow
- [ ] 4.4 Tests: `test/slice/operator.test.ts`: `status` lists a deferred candidate with `id`, `reason`, and `with`; `test/slice/events.test.ts`: the digest carries the count and drops to zero after the blocker's launch ends

## 5. Import: priority and the Scope heading

- [ ] 5.1 `src/import/mapping.ts`: `importOptionsSchema` gains `scopeHeading` default `Scope`; generalise `splitDescription` so one pass splits at every configured heading and `description` is the text before the first of them; `payloadOf` sets `scope` from the items under the scope heading, one glob per line, and omits it when the heading is absent
- [ ] 5.2 `src/import/mapping.ts`: omit a numeric `priority` of 0 from the payload; pass every other value through unchanged
- [ ] 5.3 `hosts/claude-code/skills/import/SKILL.md`: document the `Scope` heading and `options.scopeHeading`, and priority as a number where lower is more urgent (Linear's field as is, Jira's priority rank)
- [ ] 5.4 Tests: `test/import/mapping.test.ts`: scope parsed with one glob per line, headings in either order, no heading yields no scope, priority 0 absent while 1 and `High` pass through unchanged; `test/slice/import.test.ts`: an imported epic whose children declare overlapping scopes launches them one at a time

## 6. Properties and verification

- [ ] 6.1 `test/loop/reachable.test.ts`: give random nodes random scopes from a small glob set and run the reachable-state stall property with the default chain and scopes enabled; quiescent and stalled still implies non-empty `stallRoots`
- [ ] 6.2 README: document `scheduling.order`, `scheduling.scopes`, the `scope` payload key, the `Scope` heading, and `deferred` in status
- [ ] 6.3 Tests: full `npm test` green, including the crash suite and the scripted end to end, which keep running unchanged
