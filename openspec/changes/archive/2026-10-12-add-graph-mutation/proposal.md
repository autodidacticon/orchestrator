## Why

The graph is editable mid-run, but the edits that matter most are refused or silent. Reopening a done task is refused whenever anything downstream has started, and milestones count as started although they hold no work. An accepted milestone keeps its acceptance when the work under it is redone, so the acceptance no longer describes the branch. The only way past the guard is to cancel the dependents by hand, which loses the plan and the context a relaunch needs. Agents can only leave free-text follow-ups, so work they discover never becomes a node without someone retyping it. A payload edit to a running task reaches nobody. Conversation 8 (2026-10-12, `plans/4-graph-mutation/plan.md`) settled the rules: milestones are transparent to the guard and reset when upstream work reopens, cascade is an explicit flag that returns its plan, reopen never rewrites the integration branch, and agents propose structured tasks that a human accepts.

## What Changes

- Make milestones transparent to the reopen guard. The blockers of a reopen are the started non-milestone dependents reachable through any chain of milestones. Every done or submitted milestone downstream of a reopened task resets to `unstarted` with a `milestone.reset` event, keeps its review history, and is resubmitted at the next version when it is due again. Dependency edits to done or submitted milestones become compatible reloads that reset them the same way.
- Add `cascade` to `reopen` (route body, CLI `--cascade`, MCP parameter). Plain reopen stays refused with the blocker list. Cascade computes the started closure downstream of the target, returns the plan as `reset: [{ id, from }]`, and applies it in one tick: live dependents are reaped and their launches end with reason `cascade`, queued or checking or verified jobs are dropped, done dependents and the target return to `unstarted` with budgets reset. It is refused with 409 while any job in the closure is `publishing`.
- Carry a `revision` context into the next brief of every reset task: the cause, the upstream task, the prior launch, branch, published sha, and report summary, with the instruction to revise rather than redo. The integration branch is never reverted; the revision lands as a further commit.
- Add structured `proposals` to the submit report, stored pending in a new table, listed in status and the digest, and acted on through `proposals`, `accept_proposal`, and `reject_proposal`. Accepting appends a task node to the run's graph file, with the tracker identifier as id when the session created an issue, depending on the proposer and joining the proposer's gated milestone by default. Nothing is added to the graph without a human.
- Deliver a `payloadChanged` inbox notice to a live launch when a compatible reload changes its task's payload. The pinned brief stays; the next launch uses the new payload.
- Record the cascade plan before applying it, add the crash point `cascade.afterPlan`, and resume a half-applied cascade at recovery.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `task-graph`: `revocable` looks through milestones and reports the milestones a reopen resets, plus a cascade plan query; reload compatibility treats done and submitted milestones as not started and reports payload changes of started tasks.
- `task-lifecycle`: the transition table gains cascade and milestone-reset rows; the reopen guard is replaced; counters also reset on cascade; milestone acceptance does not survive an upstream reopen; new requirements for milestone reset and cascade reopen.
- `agent-protocol`: the brief gains the revision context; the submit report gains `proposals`; live launches receive the `payloadChanged` notice.
- `integration-pipeline`: reopen leaves the integration branch untouched; a revised task publishes one further trailer commit.
- `crash-recovery`: a cascade is resumable from its recorded plan through a new named crash point.
- `operator-control`: `reopen` with cascade, the proposal operations, and `proposals` in status and the digest.
- `operator-mcp`: the `reopen` tool gains `cascade`; three proposal tools.
- `host-integration`: the run skill presents proposals, creates tracker issues for accepted ones, and offers cascade when a plain reopen is refused.

## Impact

- Source: `src/graph/{query,diff}.ts`, `src/state/{status,transitions,store,sqlite}.ts` (a `proposals` table and a pending-cascade marker), `src/loop/{orchestrator,tick}.ts`, `src/launch/recovery.ts`, `src/brief/compose.ts`, `src/operator/{routes,cli,mcp-server}.ts`, `src/config.ts` (`graph.payloadChangedNotice`, `proposals.joinMilestone`), `src/crash.ts`.
- Skills: `hosts/claude-code/skills/run/SKILL.md` gains the proposal step and the cascade offer; the review skill names reopen as a repair path.
- Store schema gains one table created with `IF NOT EXISTS`; no row migration. The graph file format is unchanged: an appended proposal node is an ordinary task node whose payload carries `proposal` and `proposedBy`.
- The operator MCP tool count grows from seventeen to twenty. The "exactly seventeen" scenario in `operator-mcp` "Tool set" needs one coordinated update when the pending changes are reconciled.
- After a task is revised the integration branch carries two trailer commits for it, one per published launch; the crash suite counts per launch.
