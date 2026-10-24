---
name: orchestrator-review
description: Review a gated milestone that the orchestrator has submitted, judge the integrated work against its acceptance criteria, and accept or reject it, from a Codex session. Use when a milestone is awaiting review or the user asks to review one.
---

# Review a milestone (Codex host)

A gated milestone is submitted when every task in its closure has been verified and
published. Verification only proves the checks were green; you judge whether the work is what
was asked for. The tools named here belong to the operator MCP server
(`mcp__orchestrator_operator__<tool>`).

Pass `repo`, set to the absolute path of this session's working directory, on every
operator tool call. A plugin install starts the operator server in the plugin's own
directory, so the server cannot tell which project this session is in: without `repo` (and
before any call has passed it) a call is refused with an error naming the argument. Passing it
on every call keeps the right project even after the server restarts.

## 1. Get the bundle

Call `review` with the milestone id. It returns the pinned integration sha, the review
version, the tag `milestone/<id>/v<n>`, a diff stat against the run's baseline, the closure
tasks with their published shas and completion summaries, and the milestone's acceptance
criteria if any.

## 2. Judge

- Read the diff for the tag in the repository (`git diff <baseline>..<sha>`, or per task
  with the published shas) where the stat suggests it matters.
- For each task, compare its completion report and acceptance evidence against the task's
  acceptance criteria. Evidence that merely restates the criterion is not evidence.
- For the milestone, check its own criteria, such as a demo scenario, against the integrated
  result. Run it if the repository offers a way to; under a `read-only` sandbox, ask the user
  to run it or to allow the command.

## 3. Decide

- Accept: call `accept` with the exact `integrationSha` and `reviewVersion` from the bundle.
  A stale sha or version is refused; call `review` again.
- Reject: call `reject` with a note that says what is missing, task by task. The milestone
  becomes blocked. The repair is new or amended tasks upstream in the tracker and a re-import,
  then `unblock` on the milestone; it will be resubmitted as a new version.

Report your decision and the reasons to the user in a few lines. Never accept on the
strength of green checks alone.

## Repairing after a rejection

A rejected milestone stays blocked until the work under it changes. Two repair paths: add a
new task to the graph (or accept an agent's proposal) and `unblock` the milestone, or reopen
the offending task with the `orchestrator-run` skill's reopen flow. Reopening a task under the
milestone resets the milestone automatically; it is resubmitted at the next review version,
with a new tag at the new head, once the revised task is published. Accepting against the old
version is refused as stale.
