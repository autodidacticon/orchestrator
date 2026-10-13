---
name: work
description: Execute an orchestrated run's launches with this session's own subagents through the bundled workflow, instead of (or alongside) headless agents the daemon spawns. Use when the user wants the work done visibly in this session, with its permissions and login, or asks to "work the run", "run the tasks here", or use pull mode.
---

# Work a run with session subagents

The daemon prepares each launch (worktree, brief, token) and parks it; your workers claim
launches, do the work in the prepared worktree, and report through the operator tools. You
run the bundled workflow and handle what it hands back: questions, reviews, and the end.

## 1. Prerequisites

- The package's executables must be on PATH (`npm link` in a checkout, or a global install);
  the plugin's MCP server is `orchestrator-mcp`.
- A graph must be loaded: call `start` and then `status`; if no graph is loaded, use the
  `import` skill first.
- Call `start` with `mode: "pull"` (workers only) or `mode: "mixed"` (the daemon spawns
  whatever nobody claims within its claim window). This also switches a daemon already running.

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

The run survives the session: parked launches stay claimable and claimed launches are
governed by their leases. `stop` without `reap` leaves everything for the next `start`.
