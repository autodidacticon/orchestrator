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

## 1. Get the index

Call `review` with the milestone id and read the `view` field of the answer. The answer
decides how you read, not the tool's argument list.

- `view` is `index`: the answer carries the pinned `integrationSha`, the `reviewVersion`, the
  tag `milestone/<id>/v<n>`, the `baseline`, the milestone's own `acceptanceCriteria`, a cut
  `diffStat` and one `closure` entry per task (`taskId`, `title`, `status`, `publishedSha`, a
  cut `summary`, `summaryLength`, `acceptanceCount`, `changedFileCount`). The `diffStat` is
  the first file lines and the totals line against the run's baseline, which can include work
  of earlier milestones. Read `omitted` first: each entry names a `field`, a `count` and how to
  `fetch` what the index left out. The index holds no acceptance evidence and no task
  criteria.
- Then call `review` with `task` set to each closure task id. The answer has `view` `task`
  and one closure entry with the whole completion report (`summary`, `acceptance`,
  `interfaces`, `decisions`, `deviations`, `followUps`, `tests`, `noChanges`), the task's own
  `acceptanceCriteria` and its `changedFiles`. A task with no report fields (cancelled with
  the release) has nothing to judge but its cancellation.
- `full` returns everything in one answer (`view` `full`). It can be too large for the client,
  so the per-task reading is the normal path.
- No `view` field: the daemon is older and the answer is the whole bundle. Every entry
  already carries its evidence. Never call per task in that case.
- `view` is `index` and the `review` tool has no `task` argument: the operator server is older
  than the daemon. Fetch each task with `GET <daemonUrl>/v1/milestones/<id>/review?task=<taskId>`,
  where `daemonUrl` comes from `status`, or update the plugin.
- When the client refuses an answer for its size, in any case, save it to a file with
  `curl -s <daemonUrl>/v1/milestones/<id>/review` (add `?full=true` for the whole bundle) and
  read the file in parts. If the session refuses the command, ask the user to run it.
- When the answer has `previous`, start from it: read `git diff <previous.sha>..<integrationSha>`
  and the tasks in `previous.tasksSince`. Use the sha, not the tag name. When
  `previous.tasksSince` is absent (`previous.tasksSinceUnavailable` is true), read every closure
  task. When `previous.unavailable` is set, no prior version can be compared: review the whole
  closure as for a first version. `accept` still covers the whole pinned commit, so reading only `previous` is not
  enough.

## 2. Judge

- Read the diff for the tag in the repository (`git diff <baseline>..<sha>`, or per task
  with the published shas) where the stat suggests it matters.
- For each task, compare the report and its evidence in the one-task answer against the
  `acceptanceCriteria` in that answer. A whole-bundle entry (no `view`, or `view` `full`) holds
  no task criteria: its `acceptanceCriteria` is the milestone's. Read each task's criteria from
  its tracker issue, or from its one-task answer when the daemon gives one. Evidence that
  merely restates the criterion is not evidence.
- For the milestone, check its own criteria, such as a demo scenario, against the integrated
  result. Run it if the repository offers a way to; under a `read-only` sandbox, ask the user
  to run it or to allow the command.

## 3. Decide

- Before deciding, check that every one-task answer carried the same `integrationSha` and
  `reviewVersion` as the index. If not, the milestone was resubmitted: start the review again.
- Accept: call `accept` with the exact `integrationSha` and `reviewVersion` of the answer you
  reviewed.
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
