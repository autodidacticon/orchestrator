---
name: run
description: Start the orchestrator for this repository and monitor the run, surfacing agent questions, milestone reviews, completion and stalls. Use when the user wants to run, resume, or watch an orchestrated run.
---

# Run and monitor

The daemon does the work. You are its operator: you keep it running, relay questions to the
user, and hand milestones to the review skill. Keep the conversation small: report digests,
never raw event lists.

## 1. Start

Call `start`. It returns the run directory, graph path, URL, and the runner `mode` in force,
and is safe to repeat. A run started from this plugin defaults to `pull`: the daemon prepares
each launch and this session's own subagents do the work (section 1a), so the user sees every
agent here. `spawn` (the daemon runs headless agents, for unattended runs) and `mixed` are
explicit choices: `start` with `mode`, or `runner.mode` in `orchestrator.yaml`, which wins.
Tell the user who is executing the work. Then call `status`. If no graph is loaded, say so
and suggest the `import` skill.

## 1a. Work the run with session subagents

When the mode in force is `pull` or `mixed`, run the bundled workflow before the first `wait`,
with a worker count no larger than the run's `capacity` (from `status`), usually 2 to 4, and
a run tag such as `work-1`:

```
Workflow({ scriptPath: "<plugin dir>/workflows/work.js", args: { workers: 2, runTag: "work-1" } })
```

Each worker loop claims a launch, runs a worker subagent on its brief in the prepared
worktree, reports through the worker tools, and claims again until nothing is claimable. The
workflow runs in the background; do not wait for its completion notice, monitor with `wait`
(section 2). When the workflow has ended while launches are still claimable (a question was
answered after it stopped, or a task was retried), re-run it with the same run tag: a worker
with the same id claims its launch back. In `spawn` mode run no workflow; the daemon's agents
do the work and you only monitor.

## 2. Monitor loop

Loop on `wait` with `afterSeq` set to the `seq` returned by the previous call (omit it the
first time). Use `until` to wait for what matters: `question` when there is nothing else to
do, otherwise `any`. Each call returns within ninety seconds; call it again until the run
ends. After each return: first drain the tracker outbox (section 2a), then relay comment
answers (section 2b), then act on the digest:

- **openQuestions** non-empty: for each task, call `status` or `logs` only if you need
  context, then present the question to the user verbatim and wait for their reply. Send the
  reply with `answer`. Do not invent answers to questions that need a human decision.
- **awaitingReview** non-empty: invoke the `review` skill for each milestone.
- **finished** true: report the final state (done tasks, milestones) and stop.
- **stalled** true: report `stallRoots` with their reasons. Offer the options that apply:
  `unblock` with an answer, `cancel` with release, `reopen`, or fixing the graph and
  re-importing. Wait for the user.
- **blocked** tasks whose reason is `insufficientSpec`: tell the user which acceptance
  criteria are missing and offer to add them in the tracker and re-import.
- **stuck** non-empty: call `status` and show each stuck task with its `idleMs` and
  `lastSignal` from `liveLaunches`. Offer the user three choices: a nudge with a message
  (send it with `nudge`; the agent sees it on its next inbox call), cancellation (`cancel`),
  or waiting. The daemon fails a launch that stays stuck past `budgets.stuckFailAfterMs`
  and retries it like any other failure; say so.
- **proposals** non-empty: agents proposed follow-up tasks. For each pending proposal (from
  `proposals`), show its title, description, acceptance criteria, and deps, and wait for the
  user's decision. On acceptance in a run imported from a tracker, first create the issue
  with this session's tracker tools: a child of the epic, blocked by the proposing task's
  issue, with the acceptance criteria under the configured heading in its description; then
  call `accept_proposal` with the new issue's key as `nodeId`. In a file-based run call
  `accept_proposal` without `nodeId` and report the new node id. On rejection call
  `reject_proposal` with the user's note. Never accept a proposal the user has not approved.
- **pausedReason** is `costBudget`: the run cost reached its ceiling. Report `cost.runUsd`
  and `cost.ceilingUsd` from `status`, then offer `resume` with `overrideBudget: true`
  (raises the ceiling by one budget) or stopping. Never override the budget unless the user
  says so.
- **deferred** non-zero: ready tasks are held back because their declared scope overlaps a
  task that is running, waiting, submitted, or claimable. Read `deferred` from `status` and
  name each held task with the ids in its `with` list in the progress report ("T3 waits for
  T2's files"); do not call the run slow or stalled. Nothing to do: they launch on the first
  tick after the blocker's work is published.

Between actions, give the user a one-line progress note: running, waiting, done counts, and
the deferred tasks with their blockers when there are any.

### 2a. Drain the tracker outbox

Call `outbox`. If `policy.enabled` is false or `effects` is empty, skip this section. Each
effect names its `issue` (the tracker key), an optional `url`, and is either
`setState { state }` or `comment { body, marker }`. Apply them in `id` order with the
tracker tools in this session, acknowledging each one before the next:

- `setState`: map `state` by state TYPE, never by name. Linear: the team's workflow state of
  type `started` for `inProgress`, `completed` for `done`, `canceled` for `cancelled`. Jira:
  transition to a status in category In Progress or Done; for `cancelled`, a canceled-type
  status when the workflow has one. When the tracker has no canceled-type state, leave the
  status, post a comment saying the task was cancelled, and acknowledge. On success call
  `ack { id, result: { stateId } }`.
- `comment`: list the issue's recent comments first. If one already contains the effect's
  `marker`, call `ack { id, result: { commentId } }` with that comment's id and do not post
  again (a previous session posted it and crashed before acknowledging). Otherwise post
  `body`, a blank line, and the `marker` as the last line, then `ack { id, result: { commentId } }`.
- On a tracker error: `ack { id, error: "<message>" }`, then skip the remaining effects for
  that issue in this drain; they come back next time. The daemon retries a rejected effect
  up to its cap and then lists it in `trackerErrors`; when the digest shows `trackerErrors`,
  tell the user once which effects failed and why, and carry on.

Report one line: "tracker: applied N, rejected M". Never paste effect payloads into the
conversation.

### 2b. Relay answers from the tracker

When `policy.answersFromComments` is true and the digest lists `openQuestions`: for each
task, list its issue's comments; ignore any containing "— orchestrator run"; take the first
human comment posted after the latest marked comment that you have not relayed before; send
it with `answer`; remember that comment's id so you never relay it twice. If the daemon
answers 409, the task is no longer waiting or blocked (someone answered first): tell the
user and do not retry. Answers typed in this session still work; the first answer wins.

## 2c. Reopening a task

When the user asks to reopen a done or cancelled task, call `reopen` without `cascade`. If it
succeeds, report `reset`: the task and any milestones that were reset and will be reviewed
again at their next version. If it is refused with `blockers`, those started tasks depend on
it. Tell the user each blocker would be reset (killed if running, dropped if under
verification, reopened if done) and relaunched with a revision brief, and that the
integration branch is never rewritten. Only after the user agrees call `reopen` with
`cascade: true` and show the returned plan. If the refusal names a `publishing` task, wait a
moment and retry.

## 3. Pausing and stopping

`pause` stops new launches while running work finishes; `resume` lifts it. `stop` shuts the
daemon down gracefully: agents keep running and are adopted on the next `start`. Only pass
`reap: true` when the user explicitly wants agents killed.

## 4. When the session ends

The run's state is durable. A launch held by one of this session's workers is handed back
when the session ends, with its branch kept and any uncommitted work committed on it; the
next launch is briefed to continue from that branch, and no attempt is spent. Parked
launches wait for the next worker. The daemon exits on its own after `daemon.idleExitMs`
(ten minutes by default) with no session attached and nothing live, records why in the run
directory, and comes back on the next tool call; `runs` shows every run with its daemon's
state or last exit. Tell the user they can come back and use the `run` skill again; nothing
is lost. Questions that nobody answers degrade to blocked after the configured wait and can be
answered later with `answer`.
