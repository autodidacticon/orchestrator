# Mutate the graph mid-run: plan for change `add-graph-mutation`

## Context

v1 (`plans/0-orchestrator-v1/plan.md`) chose a strict reopen guard: a done or cancelled node
can be reopened only when no dependent has started, and done counts as started. The session
operator (`plans/1-session-operator/plan.md`) made the graph file something a session rewrites
through the daemon. Conversation 8 on 2026-10-12 looked at what the guard costs in practice
and settled four things: milestones hold no work and must not block a reopen or keep a stale
acceptance; cascading a reopen through started dependents is an explicit, visible operation;
reopening never rewrites the integration branch; and agents propose follow-up work in a
structured form that a human accepts. A fifth, smaller item rides along: a payload edit to a
running task reaches the agent as a notice. This document records the decisions and their
reasoning; the OpenSpec change `add-graph-mutation` holds the requirements, design record,
and task checklist.

## Decisions

1. **Milestones are transparent to the reopen guard.** `revocable` looks through milestones:
   the blockers are the started non-milestone dependents reachable through any chain of
   milestones. Every done or submitted milestone downstream of a reopened task resets to
   unstarted with a `milestone.reset` event and reason `upstreamReopened`. A gated milestone
   keeps its review history (`reviewVersion` keeps counting, tags stay) and is resubmitted at
   the next version when due again; a submitted one drops its pending review. Milestones are
   also not started for reload compatibility, so a dependency edit on a done or submitted
   milestone is compatible and resets it the same way. Rejected: transparency for auto
   milestones only (an accepted gated milestone would block the reopen or keep an acceptance
   that no longer describes the branch) and the status quo.
2. **Cascade is an explicit flag that returns its plan.** Plain `reopen` stays refused with
   the blocker list. `reopen` with `cascade` computes the started closure downstream, tasks
   and milestones, returns it as `reset: [{ id, from }]`, and applies it in one tick: live
   dependents are reaped with launch reason `cascade`, queued or checking or verified jobs are
   dropped, done dependents and the target return to unstarted. Any job in the closure in
   `publishing` refuses the whole request with 409; the caller retries after it settles. Every
   reset task gets `attempts` and `integrationRetries` zeroed and a revision context.
   Rejected: always cascade (too easy to discard a dozen tasks by accident) and the strict
   guard alone (cancelling by hand loses the plan, the end reason, and the context).
3. **Reopen never touches the integration branch.** The published commit stays; the next
   launch bases on the current head; the revision lands as one more trailer commit for the
   same task. The brief carries `revision` (cause, upstream task, prior launch, branch,
   published sha, report summary) and tells the agent to revise, not redo. Rejected: revert
   on reopen, which rewrites what sibling work was built on and conflicts with every sibling.
4. **Proposals are structured, stored, and held for a human.** The submit report gains
   `proposals` (title, description, acceptance criteria, optional deps, scope, labels);
   `followUps` stays free text. The daemon validates deps at report time, stores proposals
   pending in a new table, and lists them in status and the digest. `accept_proposal` appends
   a task node to the graph file (id from the tracker when the session created an issue, else
   the proposal id), depending on the proposal's deps plus the proposer, and joining every
   gated milestone whose closure contains the proposer under `proposals.joinMilestone`
   (default true). The write reuses the import route's atomic write and reload. Rejected:
   agents append to the graph themselves, and free text only.
5. **A payload edit to a live task is a notice.** A compatible reload that changes a running
   or waiting task's payload puts `{ kind: 'payloadChanged', rev }` in its launch inbox. The
   pinned brief is unchanged; the next launch uses the new payload. `graph.payloadChangedNotice`
   turns it off. Dependency edits to started tasks stay incompatible.
6. **Cascade is a recorded plan applied by per-node transactions.** The plan and a pending
   marker are written together before any effect; each reset is its own transaction; the
   marker clears with the last reset. Recovery re-reads the marker and applies what is still
   started. New crash point `cascade.afterPlan`. Reaping and job dropping reuse what exists.
7. **The run skill fronts both features.** It presents proposals, creates the tracker issue
   for an accepted one (child of the epic, blocked by the proposer, criteria under the
   configured heading) and passes its key as `nodeId`, accepts directly in file-based runs,
   and on a refused reopen shows the blockers and offers cascade with the plan.

## Implementation

Seven task groups in `openspec/changes/add-graph-mutation/tasks.md`:

1. Guard, milestone transparency, and reload (`revocable` with `resets`, `cascadePlan`,
   classifier changes, two transition rows, milestone reset in `reopen` and `loadGraph`).
2. Cascade reopen (plan, marker, refusal while publishing, `applyPendingCascade` in phase 1,
   verifier outcome discard, route, CLI, and MCP parameter).
3. Revision context and the integration branch (`RevisionContext`, brief section, slice test
   with the real verifier showing the head unchanged and a second trailer commit).
4. Proposals (report schema and validation, `proposals` table, status and digest, routes,
   graph append with `joinMilestone`, CLI and MCP tools).
5. Payload change notice (classifier field, inbox notice, config key).
6. Crash safety (crash point, recovery from the marker, crash suite cascade scenario).
7. Skills and documentation (run and review skills, README, scripted end to end).

Gate: group 2's cascade tests and group 6's crash scenario. Groups 1 and 2 go first because
later groups build on the reset and the revision context; group 4 can run in parallel.

## Verification

- `npm test` green including the v1 and session-operator suites; the crash matrix runs the
  standard fixture for the existing points and the cascade scenario for `cascade.afterPlan`
  and the tick phases.
- Property tests: blockers equal the started non-milestone nodes on milestone-only paths over
  random DAGs; after any cascade through the real tick no started task depends on an
  unstarted node.
- Slice tests with scripted agents and the real verifier: a cascade reaps a live dependent
  with end reason `cascade`, drops a queued job, resets a done dependent with zero budgets,
  leaves the integration head and tags unchanged, and the revised task publishes a second
  trailer commit; a proposal round-trips through report, list, accept with and without
  `nodeId`, and the node runs after the proposer with its milestone reset.
- Recovery: a cascade interrupted at `cascade.afterPlan` and after its first reset converges
  with each node reset exactly once.
- Scripted end to end through the MCP server: a scripted agent proposes, the test accepts,
  the node runs, the milestone resubmits at version 2 with a new tag.
- Sync hazard: `add-pull-runner` also replaces `Transition table enforcement` in
  task-lifecycle. Whichever change archives second must first fold the other's rows into
  its block, because the sync replaces the requirement wholesale.

## Deferred

- `until: proposal` on `wait`; the digest carries proposals and the run skill reads it on
  the next return.
- A coordinated rewrite of the operator MCP "Tool set" scenario, which pins a tool count,
  when the pending changes are reconciled.
- Mirroring proposal and reopen state to the tracker (conversation 9), scheduling policy (5),
  health monitoring (7), and the pull-based runner.
