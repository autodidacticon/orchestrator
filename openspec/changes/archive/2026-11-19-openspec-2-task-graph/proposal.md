## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Two of the twelve requirements of `task-graph` are over the limit: "Reload compatibility" (1627 characters) and "Revocability through milestones" (729). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-158).

## What Changes

- MODIFIED "Reload compatibility": header and all nine scenarios kept unchanged; the description is cut to re-reading and classifying the graph file, when a task is started, and which changes are compatible (356 characters). The other behaviors move to seven ADDED requirements.
- MODIFIED "Revocability through milestones": header and all four scenarios kept unchanged; the description is cut to milestones being transparent and which nodes are blockers (331 characters). The other behaviors move to two ADDED requirements.
- Nine ADDED requirements, each with a description of at most 500 characters and scenarios of its own. No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped (20 in the original descriptions, 20 in the cut and ADDED ones). No sentence of the original descriptions is longer than 500 characters (the longest is 395), so no sentence is split and no lead-in is added.

### Moved sentences: "Reload compatibility"

- "The system SHALL re-read the graph file when it changes and SHALL classify the differences against the active snapshot." stays, unchanged.
- "A task is started when its status is `running`, `waiting`, `submitted`, or `done`." stays, unchanged.
- "Adding a node, removing a node that is not started, and changing `deps`, `payload`, `kind`, or `gated` of a node that is not started SHALL be compatible." stays, unchanged.
- "A milestone SHALL never count as started for reload compatibility, so its `deps`, `payload`, and `gated` flag may change on any reload." moves to **Reload compatibility: milestones are never started**, unchanged.
- "Removing a started task, changing `deps` or `kind` of a started task, or producing a graph that fails validation SHALL be incompatible, with one exception: ... its entry SHALL be left unchanged and the node SHALL be listed under `changed`." moves to **Reload compatibility: incompatible changes**, unchanged and whole (395 characters).
- "A done task becoming an external with `done: false`, and an external becoming a task while its entry is `done`, SHALL remain incompatible." moves to **Reload compatibility: done externals that stay incompatible**, unchanged.
- "A compatible reload that changes the `deps` of a milestone whose status is `done` or `submitted` SHALL reset that milestone to `unstarted` with event `milestone.reset` and reason `depsChanged`, retaining its review history." moves to **Reload compatibility: milestone reset on changed deps**, unchanged.
- "A compatible classification SHALL list `payloadChanged`, the ids of started tasks whose `payload` differs from the active snapshot." moves to **Reload compatibility: payload changes of started tasks**, unchanged.
- "An incompatible reload MUST be rejected as a whole, the active snapshot MUST remain in force, and status MUST report `graphRejected` with the reasons." moves to **Reload compatibility: rejection keeps the active snapshot**, unchanged.
- "The overlay entry of a removed node SHALL be retained and the node SHALL never be scheduled." moves to **Reload compatibility: removed nodes**, unchanged.

### Moved sentences: "Revocability through milestones"

- "`revocable` SHALL treat milestone dependents as transparent." stays, unchanged.
- "The blockers of a `done` or `cancelled` node SHALL be exactly the non-milestone dependents ... and a milestone SHALL never be a blocker." stays, unchanged.
- "The result SHALL also list `resets`, every milestone reachable downstream from the node whose status is `done` or `submitted`." moves to **Revocability: milestone resets**, with its reference made explicit: "The result" becomes "The result of `revocable`".
- "The system SHALL compute a cascade plan for a node as the node itself together with every started node reachable downstream through any chain of dependents, tasks and milestones alike, each with its current status as `from`, ordered dependents before their dependencies." moves to **Cascade plan**, unchanged.

### Where the new scenarios come from

Each new scenario states behavior the code has at the change's base commit (7028b2b):

- Reload compatibility: milestones are never started: `test/graph/diff.test.ts` ("a dependency change on a submitted milestone is compatible and listed; ..."), `src/graph/diff.ts` (`classifyReload`: `started` is false for a milestone).
- Reload compatibility: incompatible changes: `test/graph/diff.test.ts` ("payload or gated change on a started node is compatible; kind change is not").
- Reload compatibility: done externals that stay incompatible: `test/graph/diff.test.ts` ("a done task may become a done external; an unfinished external or a running task may not").
- Reload compatibility: milestone reset on changed deps: `test/loop/scenarios.test.ts` ("a submitted milestone resets when its deps change on reload; ...").
- Reload compatibility: payload changes of started tasks: `test/graph/diff.test.ts` ("a dependency change on a submitted milestone is compatible and listed; payload edits of started tasks are listed").
- Reload compatibility: rejection keeps the active snapshot: `test/loop/scenarios.test.ts` ("incompatible reload is rejected whole and reported; compatible add is accepted").
- Reload compatibility: removed nodes: `test/graph/diff.test.ts` ("cancel then remove is compatible and keeps the orphan entry"), `src/graph/query.ts` (`ready` iterates the nodes of the graph only, so a removed node is never ready).
- Revocability: milestone resets: `test/graph/query.test.ts` ("milestones are transparent: a done milestone resets instead of blocking; ...", the `submitted` MVP case).
- Cascade plan: `test/graph/query.test.ts` ("cascade plan is the started closure, dependents before their dependencies", the last assertion).

## Capabilities

### New Capabilities

### Modified Capabilities

- `task-graph`: "Reload compatibility" and "Revocability through milestones" are cut to one behavior each; nine requirements are added to hold the moved sentences.

## Impact

Only `openspec/changes/openspec-2-task-graph/` changes. No code changes.
