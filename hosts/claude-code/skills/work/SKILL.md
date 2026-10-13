---
name: work
description: Add this session's subagents as workers to an orchestrated run, or switch the run's mode, through the bundled workflow. The run skill already works a pull-mode run; use this to add workers from another session, to work a run that was started in spawn mode, or when the user asks to "work the run" or "run the tasks here".
---

# Work a run with session subagents

The daemon prepares each launch (worktree, brief, token) and parks it; your workers claim
launches, do the work in the prepared worktree, and report through the operator tools. The
`run` skill does this by itself for a run in `pull` mode. Use this skill to add workers from a
second session, to work a run that is in `spawn` mode, or to switch modes; then handle what
the workflow hands back: questions, reviews, and the end.

## 1. Prerequisites

- A graph must be loaded: call `start` and then `status`; if no graph is loaded, use the
  `import` skill first.
- `start` reports the mode in force. A plugin-started run is already `pull`. To work a run in
  `spawn` mode, call `start` with `mode: "pull"` (workers only) or `mode: "mixed"` (the
  daemon spawns whatever nobody claims within its claim window); this switches a daemon
  already running.

## 2. Run the workflow

Pick a worker count no larger than the run's `capacity` (from `status`), usually 2 to 4, and a
run tag such as `work-1`. Run the plugin's workflow `work.js` with the Workflow tool:

```
Workflow({ scriptPath: "<plugin dir>/workflows/work.js", args: { workers: 2, runTag: "work-1" } })
```

Each worker loop claims a launch with the worker id `<runTag>-<n>`, runs a worker agent on
the brief, and claims again until nothing is claimable. The workflow runs in the background
and returns short outcomes per launch; never paste briefs or logs into the conversation.

## 3. Monitor while it runs

Do not wait for the workflow's completion notice; monitor the run yourself. Loop on `wait`
with `afterSeq` from the previous call and `until: "any"`, and act on each digest:

- **openQuestions** non-empty: show each question to the user verbatim and send the reply
  with `answer`. The worker holding that launch is polling `launch_block` and continues as
  soon as the answer is admitted; no re-run is needed. If the workflow has already ended,
  re-run it with the same run tag: the worker with the same id claims its launch back and
  collects the answer.
- **awaitingReview** non-empty: invoke the `review` skill for each milestone.
- **finished** true: report the final state and stop looping.
- **stalled** true, or `claimable` is 0 with no `workers` in `status` and the workflow has
  ended: report `stallRoots` and offer the `run` skill's remedies (unblock, cancel with
  release, reopen with cascade, re-import).

Between digests give the user a one-line note: claimable, workers, done counts. When the
workflow's completion notification arrives, read its outcomes and keep monitoring until the
digest says the run is finished.

## 4. Stopping

The run survives the session: parked launches stay claimable, and a launch held by one of
this session's workers is handed back with `keep` when the session ends (its branch kept,
uncommitted work committed on it, no attempt spent). A worker that must stop for an outside
reason does the same itself with `release` and `keep: true`; a worker that gives up on the
task releases without `keep`, which spends the attempt and briefs the retry with its reason.
`stop` without `reap` leaves everything for the next `start`; after an idle exit the daemon
comes back on the next tool call.
