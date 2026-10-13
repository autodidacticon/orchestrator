## 1. Guard, milestone transparency, and reload

- [x] 1.1 `src/graph/query.ts`: make `revocable` look through milestones (blockers are started non-milestone dependents reachable through milestone chains) and return `resets`, the done or submitted milestones downstream; add `cascadePlan(g, overlay, id)` returning `[{ id, from }]` dependents-first
- [x] 1.2 `src/graph/diff.ts`: treat milestones as not started for classification; add `payloadChanged` and `milestoneDepsChanged` to the compatible result
- [x] 1.3 `src/state/transitions.ts`: add rows `running|waiting|submitted|done -> unstarted` by human with trigger `cascade` and `resetBudgets`, and `milestone done|submitted -> unstarted` by orchestrator with trigger `milestoneReset`
- [x] 1.4 `src/loop/orchestrator.ts`: `reopen` resets every milestone in `resets` (clear `accepted` and `integrationSha`, keep `reviewVersion`, event `milestone.reset` with reason `upstreamReopened`) and returns `reset`
- [x] 1.5 `src/loop/orchestrator.ts`: `loadGraph` resets milestones in `milestoneDepsChanged` with reason `depsChanged` after a compatible reload
- [x] 1.6 `src/loop/tick.ts` and `src/launch/recovery.ts`: milestone tagging after a reset uses the retained `reviewVersion`, so the next submission tags `v<n+1>` and recovery's idempotent re-tag keys on the new version
- [x] 1.7 Tests: `test/graph/query.test.ts` revocable through a done milestone, blocker behind a milestone, cascade plan on the standard fixture; `test/graph/properties.test.ts` blockers equal started non-milestone nodes on milestone-only paths; `test/graph/diff.test.ts` submitted-milestone dep change is compatible and payload change is listed; `test/state/transitions.test.ts` new rows; `test/loop/scenarios.test.ts` rewrite the done-milestone guard scenario to expect the reset and add resubmission at version 2 with a new tag

## 2. Cascade reopen

- [x] 2.1 `src/state/store.ts` and `src/state/sqlite.ts`: pending-cascade marker under kv `cascade.pending`; `listJobs` by task across non-terminal states; `dropJob(jobId)` marking `dropped` and applied
- [x] 2.2 `src/loop/orchestrator.ts`: `reopen(taskId, { cascade })` computes the plan, refuses with 409 while any planned node's job is `publishing`, records `operator.reopen` with the plan and the marker in one transaction, calls `crashPoint('cascade.afterPlan')`, and wakes the tick
- [x] 2.3 `src/loop/tick.ts`: `applyPendingCascade` at the start of phase 1: per-node transactions dependents-first, reap live launches and end them with reason `cascade`, drop queued or checking or verified jobs, defer a publishing node, reset done nodes and the target, reset milestones, clear the marker when nothing planned is still started
- [x] 2.4 `src/loop/orchestrator.ts`: `runVerifierJob` discards its outcome when the job is no longer live; `resolveWaiters` for cascaded waiting launches with reason `cascade`
- [x] 2.5 `src/operator/routes.ts`: `cascade` in the reopen body; 409 bodies carry `blockers` or the publishing task; 200 bodies carry `reset`
- [x] 2.6 `src/operator/cli.ts` and `src/operator/mcp-server.ts`: `reopen <task> [--cascade]` and the `cascade` tool parameter, both forwarding the body unchanged
- [x] 2.7 Tests: `test/loop/cascade.test.ts` plan equals the started closure, live dependent reaped with end reason `cascade`, queued job dropped, done dependent reset with budgets zero, refused while a fake job is held in `publishing`, plain reopen still refused with blockers; `test/loop/reachable.test.ts` add a cascade action and assert no started task has an unstarted dep; `test/slice/operator.test.ts` route, CLI, and MCP paths

## 3. Revision context and the integration branch

- [x] 3.1 `src/state/status.ts`: `RevisionContext { cause, upstream?, priorLaunchId, priorBranch, priorPublishedSha?, priorReportSummary? }` on `AttemptContext.revision`
- [x] 3.2 `src/loop/orchestrator.ts`: build the revision context at reopen, uncancel, and every cascade reset from the latest launch, the latest published job, and the completion report
- [x] 3.3 `src/brief/compose.ts`: a `## Revision` section in brief.md and `context.revision` in brief.json stating the prior commit is in `baseSha` and instructing the agent to revise
- [x] 3.4 Tests: `test/loop/brief.test.ts` revision section for a published and for a killed prior launch; `test/slice/cascade.test.ts` with scripted agents and the real verifier: head unchanged after reopen, tags intact, no foreign commit, two `Orchestrator-Task: T1` trailer commits after the revision, next briefs carry the context

## 4. Proposals

- [x] 4.1 `src/loop/orchestrator.ts`: `proposalSchema` and `proposals` in `submitBodySchema`; validate deps against the launch's graph revision; 400 on failure with the task still running; store pending proposals `<taskId>-p<n>` when the report is accepted
- [x] 4.2 `src/state/store.ts` and `src/state/sqlite.ts`: `proposals` table (id, task_id, launch_id, status, payload, node_id, note, created_at, decided_at) with `createProposal`, `updateProposal`, `getProposal`, `listProposals`
- [x] 4.3 `src/loop/orchestrator.ts`: `proposals` in `StatusReport`; `src/operator/routes.ts`: `proposals` in `digestOf`, `GET /v1/proposals`, `POST /v1/proposals/:id/accept`, `POST /v1/proposals/:id/reject`
- [x] 4.4 `src/operator/routes.ts`: factor the atomic write and reload out of `PUT /v1/graph`; accept appends the node (id, deps plus proposer, payload with `proposal` and `proposedBy`), adds it to the deps of every gated milestone whose closure contains the proposer when `proposals.joinMilestone` is true, validates, writes, reloads, marks accepted; idempotent when the node is already present
- [x] 4.5 `src/config.ts`: `proposals.joinMilestone` default true
- [x] 4.6 `src/operator/cli.ts`: `proposals [--status]`, `accept-proposal <id> [--node-id] [--payload <json>]`, `reject-proposal <id> --note`; `src/operator/mcp-server.ts`: `proposals`, `accept_proposal`, `reject_proposal` with zod input schemas
- [x] 4.7 Tests: `test/state/sqlite.test.ts` table round trip; `test/slice/proposals.test.ts` report with proposals stored pending, malformed proposal answered 400, list, accept with and without `nodeId`, node appears with the right deps and payload, runs after the proposer, submitted milestone gains the dep and resets, reject with note, accept twice; `test/slice/operator-mcp.test.ts` the three tools

## 5. Payload change notice

- [x] 5.1 `src/config.ts`: `graph.payloadChangedNotice` default true
- [x] 5.2 `src/loop/orchestrator.ts`: after a compatible reload append `{ kind: 'payloadChanged', rev }` to the live launch notices of every running or waiting task in `payloadChanged`, with event `graph.payloadChanged`
- [x] 5.3 Tests: `test/loop/scenarios.test.ts` notice returned by the next inbox call and brief file unchanged, nothing when disabled, next launch after a failure composes from the new payload; `test/slice/shim.test.ts` the `inbox` tool surfaces it

## 6. Crash safety

- [x] 6.1 `src/crash.ts`: add `cascade.afterPlan`
- [x] 6.2 `src/launch/recovery.ts`: read `cascade.pending` and apply the remaining resets before the first tick, reusing the tick's `applyPendingCascade`
- [x] 6.3 `test/crash/harness.ts` and `test/crash/crash.test.ts`: a cascade scenario (T1 done, T2 running, MVP submitted, operator reopens T1 with cascade) run at `cascade.afterPlan` and at each tick phase, with trailer commits counted per published launch; keep the standard matrix for the other points
- [x] 6.4 Tests: `test/loop/cascade.test.ts` in-process crash hook after the first reset, restart, recovery resets the rest once and clears the marker

## 7. Skills and documentation

- [x] 7.1 `hosts/claude-code/skills/run/SKILL.md`: proposal step (present, tracker issue creation with child, blocked-by, and criteria heading, `accept_proposal` with or without `nodeId`, `reject_proposal`), and the reopen flow (show blockers, offer cascade, show the plan)
- [x] 7.2 `hosts/claude-code/skills/review/SKILL.md`: name reopen of the offending task as a repair path and state that the milestone resets and resubmits at the next version
- [x] 7.3 README: document cascade, proposals, the two config keys, and link `plans/4-graph-mutation/plan.md` from the plans index
- [x] 7.4 Tests: `test/e2e/scripted.test.ts` a scripted agent proposes, the test accepts through the MCP server, the node runs after the proposer; `test/e2e/plugin.test.ts` plugin still validates with the updated skills
- [x] 7.5 Before archiving: re-read `openspec/specs/task-lifecycle/spec.md` and fold into this change's MODIFIED `Transition table enforcement` block the release row and scenario from `add-pull-runner` if it was archived first; sync replaces the block wholesale
