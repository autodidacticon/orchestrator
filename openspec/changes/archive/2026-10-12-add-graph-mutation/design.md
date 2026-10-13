## Context

v1 gave the daemon a strict reopen guard: a done or cancelled node is revocable only when no dependent is started, and started includes done. Milestones are dependents too, so once MVP is done nothing under it can be reopened without reopening MVP first, and reopening MVP by hand records nothing about why. The guard exists to stop silent invalidation of work; conversation 8 (2026-10-12) kept that intent and removed the collateral. Milestones carry no work, so they should neither block a reopen nor keep an acceptance of a branch that is about to change. The same conversation decided how work that agents discover enters the graph and how a payload edit reaches a running agent. Constraints: the daemon stays the sole writer; every operator action is an event applied by the tick; the orchestrator only appends to the integration branch; the graph file remains the source of truth that a session or a person edits.

## Goals / Non-Goals

**Goals:**
- Reopen a task whose only started dependents are milestones, and have those milestones reviewed again against the revised branch.
- Reopen a task with started dependents in one explicit operation whose plan is visible in the response and in the event log.
- Give a relaunched task what it needs to revise its published work instead of redoing it.
- Let agents propose follow-up tasks that a human accepts into the graph, with tracker issues created by the session when the run came from a tracker.
- Tell a live agent when its task's payload changed.
- Keep every new multi-step effect crash-safe under the existing recovery model.

**Non-Goals:**
- Reverting or rewriting the integration branch on reopen.
- Automatic cascade, or automatic acceptance of proposals.
- Dependency edits to started tasks on reload; they stay incompatible.
- Mirroring proposal state to the tracker beyond the issue the session creates (conversation 9).

## Decisions

**Milestones are always transparent to the reopen guard.** `revocable` ignores milestone dependents and follows their dependents instead, so the blockers are exactly the started non-milestone dependents reachable through any chain of milestones. Every done or submitted milestone downstream of the reopened task resets to `unstarted` with `milestone.reset` and reason `upstreamReopened`. `reviewVersion` keeps counting, existing tags stay, `accepted` and `integrationSha` are cleared, and a submitted one drops its pending review. Reload compatibility treats done and submitted milestones as not started for the same reason, so a dependency edit on one is compatible and resets it with reason `depsChanged`. Alternative: transparent for auto milestones only. Rejected because an accepted gated milestone would then either block the reopen or keep an acceptance of a branch that is about to change, which are the two problems being fixed. Alternative: status quo. Rejected because reopening MVP by hand before T3 is the same reset with worse ergonomics and no record of the cause.

**Cascade is an explicit flag that returns its plan.** Plain `reopen` keeps refusing with the blocker list. `reopen` with `cascade: true` computes the started closure downstream of the target, tasks and milestones, records the plan in the `operator.reopen` event, returns it as `reset: [{ id, from }]`, and applies it in one tick in reverse topological order: running or waiting dependents are reaped and their launches ended with reason `cascade`; submitted dependents have their job dropped when it is queued, checking, or verified; done dependents and the target return to `unstarted`. If any job in the closure is `publishing` the request is refused with 409 and the caller retries after it settles, because a publication cannot be undone and must not race the reset. Alternative: always cascade. Rejected because one reopen of a root task could silently discard a dozen tasks of work. Alternative: keep the strict guard only. Rejected because cancelling dependents by hand loses the plan, the end reason, and the budget and context resets that make the relaunch a revision.

**Reopen never touches the integration branch.** The published commit stays, the next launch bases on the current head, and the revision lands as one more trailer commit for the same task. The brief carries a `revision` context (cause, upstream task, prior launch, branch, published sha, report summary) and tells the agent to revise. Alternative: revert the task's commit on reopen. Rejected because it rewrites what verified sibling work was built on, invites a conflict for every sibling, and turns the next review into a diff against a branch that no longer exists.

**Proposals are structured, stored, and held for a human.** The submit report gains `proposals` with title, description, acceptance criteria, and optional deps, scope, and labels; `followUps` stays free text for everything that is not a task. The daemon validates them at report time against the launch's graph revision, stores them pending in a `proposals` table, and lists them in status and the digest. `accept_proposal` appends a task node to the run's graph file with the given `nodeId` or the proposal id, deps equal to the proposal's deps plus the proposer, payload from the proposal, and, under `proposals.joinMilestone` (default true), a dependency edge from every gated milestone whose closure contains the proposer. That edge is compatible even when the milestone is submitted because of the first decision. The write reuses the import route's atomic write and reload. Alternative: agents append to the graph file. Rejected because the graph would grow without a human and the sole-writer rule would break. Alternative: free text only. Rejected because it is what exists today and the work never becomes a node.

**A payload edit to a live task is a notice, not a relaunch.** On a compatible reload the classification reports which started tasks' payloads changed; each live launch among them gets the inbox notice `{ kind: 'payloadChanged', rev }`. The pinned brief is unchanged and the next launch composes from the new payload. `graph.payloadChangedNotice` turns it off. Alternative: fail and relaunch the task. Rejected because the edit is usually a clarification and the agent can decide to finish or to ask.

**Cascade is a recorded plan applied by per-task transactions.** The plan and a pending-cascade marker are written in one transaction before any effect, each reset is its own transaction, and the marker is cleared with the last reset. Recovery re-reads the marker and applies what is still started, so a crash at the new point `cascade.afterPlan` converges. Reaping and job dropping reuse reconcile and the cancel path.

## Risks / Trade-offs

- [Cascade resets more than the operator expected] → the plan is returned and recorded; the skill shows it before the user confirms; budgets and the revision context make a relaunch cheap; the integration branch is untouched.
- [A reset milestone resubmits at a sha that already carries a tag] → tags are per version and idempotent; the next version gets its own tag even at the same sha.
- [Proposal deps name ids the graph does not have] → validated at report time; a bad proposal is a malformed report answered 400, and the task stays running to fix it.
- [A proposal accepted twice, or the daemon dies after writing the file and before marking it] → the appended node carries `proposal: <id>`; accept finds it and marks the proposal accepted without a second write.
- [Two trailer commits for one task after a revision] → expected; the crash-suite invariant counts per published launch once a task was reopened.
- [A job moves from queued to checking between plan and application] → application drops it, and the in-flight verifier result is discarded when its job is no longer live.
- [`isStarted` is shared by the guard and the reload classifier] → the milestone exception lives in the two callers, not in `isStarted`, so other uses keep their meaning.

## Migration Plan

Store: one new table created with `IF NOT EXISTS` and one new kv key; no row migration. Graph files: unchanged format. Config: two optional keys with defaults. Existing tests that reopen a milestone by hand keep working; the scenario that expected a done milestone to guard its constituents is rewritten to expect the reset.

## Open Questions

- Whether `wait` should gain `until: proposal`. The run skill can act on the digest at the next return, so it is left out.
- Whether the operator MCP "Tool set" scenario should state a count at all once several pending changes add tools.
- Whether the run skill should try plain `reopen` first and offer cascade on refusal, or ask up front when the user names a task with started dependents.
