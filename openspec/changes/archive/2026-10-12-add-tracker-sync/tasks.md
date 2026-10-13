## 1. Config and outbox store

- [x] 1.1 Add the `tracker` block to `src/config.ts`: `enabled` (`auto` | `always` | `never`, default `auto`), `maxAttempts` 3, `parentInProgress` true, `commentOnDone` false, `commentOnFail` false, `doneAt` (`integration` | `milestoneAccepted`, default `integration`), `answersFromComments` true
- [x] 1.2 Add `OutboxEffect`, `EffectKind`, and `EffectStatus` to `src/state/store.ts` with the methods `insertOutbox` (no-op on an existing `(sourceSeq, taskId, kind)`), `listOutbox({ status, afterId, limit })`, `getOutbox`, `ackOutbox(id, result)`, `nackOutbox(id, error, maxAttempts)`, `countOutbox(status)`, and `lastSetState(taskId)`
- [x] 1.3 Create the `outbox` table in `src/state/sqlite.ts` with `id`, `source_seq`, `task_id`, `kind`, `payload`, `status`, `attempts`, `result`, `error`, `created_at`, `applied_at`, a unique index on `(source_seq, task_id, kind)`, and an index on `status`
- [x] 1.4 Add typed kv helpers for `tracker` (`{ kind, workspace?, recordedAt }`) and `runId` to `src/state/store.ts`; set `runId` in `src/main.ts` from the run directory id (`runIdFor` in `src/runs/runDir.ts`) or a random id under `--config`
- [x] 1.5 Tests in `test/state/outbox.test.ts`: duplicate insert keeps one row, list order and paging, ack stores the result and `appliedAt`, nack below the cap stays pending with `attempts` increased, nack at the cap is `failed`, duplicate ack is unchanged, `lastSetState`, an existing store opens with an empty outbox

## 2. Effect derivation

- [x] 2.1 Implement `src/tracker/policy.ts`: `trackerEnabled(config, store)` for `auto` | `always` | `never`, `hasTrackerIdentity(node)` (payload `url` or `trackerState`), and `policyReport(config, store)` returned by the outbox route
- [x] 2.2 Implement `src/tracker/effects.ts`: `deriveEffects(ctx, t)` where `t` is `{ id, node, from, to, actor, trigger, entry, seq, extra }`, returning outbox rows; `setState` rules from "State effects" including the differs-from-last rule and `parentInProgress` over milestones whose `deps` contain the task
- [x] 2.3 Implement comment derivation in `src/tracker/comments.ts`: bodies for question, blocked (reason kind, message, missing slots, `whatWouldUnblock` from the fail report detail), milestone submitted (sha, tag, diff stat, closure list), accepted, rejected, done (sha, summary when `commentOnDone`), failed (when `commentOnFail`); marker `— orchestrator run <runId> · event <sourceSeq>`
- [x] 2.4 Implement `doneAt` in `src/tracker/effects.ts`: at `milestoneAccepted`, a done task under a gated milestone (`closure` in `src/graph/query.ts`) gets the integrated comment and its `setState done` is derived at the first acceptance of such a milestone; tasks under none flip at publication
- [x] 2.5 Suppress the repeat comment on `waiting` to `blocked` with the same question (`maxWaitOrDead`), and derive nothing for `external` nodes or nodes without identity
- [x] 2.6 Hook derivation into `src/loop/orchestrator.ts`: `transition` accepts `extra`, `recordTransition` returns the event seq, and both call `deriveEffects` and `insertOutbox` inside the same transaction
- [x] 2.7 Gather context in `src/loop/tick.ts`: `drainVerification` passes `publishedSha` and the completion summary on `published`; `completeMilestones` computes the baseline diff stat (`workspace.diffStat`) and the closure list before the gated `submitted` transition and passes them as `extra`
- [x] 2.8 Pass context from `src/loop/orchestrator.ts`: `fail` passes the fail report's `whatWouldUnblock`, `acceptMilestone` passes sha and version, `rejectMilestone` passes the note
- [x] 2.9 Tests in `test/loop/tracker-effects.test.ts` with `test/loop/harness.ts` and a tracked fixture `test/fixtures/graphs/tracked.yaml` (the standard fixture with `url` and `trackerState`): one `inProgress` per task across retry and conflict relaunch; parent follows the first child, and not when `parentInProgress` is false; done at integration and at milestone acceptance; task outside a gated milestone; question, exhaustion, insufficientSpec, submitted, accepted, rejected comments; no repeat on timeout; `commentOnDone` and `commentOnFail` off then on; reopen sets `inProgress` again; `never` and an unrecorded tracker derive nothing; a hand-added node derives nothing

## 3. Routes, status, and CLI

- [x] 3.1 Add `GET /v1/outbox` (`after`, `limit` default 50, pending only, plus `policy`), `POST /v1/outbox/:id/ack { result }`, and `POST /v1/outbox/:id/nack { error }` to `src/operator/routes.ts`; 404 on an unknown id; ack of an applied effect returns the stored result unchanged; nack uses `config.tracker.maxAttempts`
- [x] 3.2 Append `operator.ack` and `operator.nack` events in `src/operator/routes.ts` before applying them, as every operator action is an event
- [x] 3.3 Accept `tracker` in `PUT /v1/graph` in `src/operator/routes.ts`: validate with `trackerSchema`, store under kv `tracker`, append `tracker.recorded`; leave the record alone when absent
- [x] 3.4 Add `tracker`, `outboxPending`, and `trackerErrors` (`{ id, taskId, kind, attempts, error }`) to `StatusReport` in `src/loop/orchestrator.ts` and to the no-graph status body in `src/operator/routes.ts`
- [x] 3.5 Add `outboxPending` and `trackerErrors` to `digestOf` in `src/operator/routes.ts`
- [x] 3.6 Add `outbox [--after <id>] [--limit <n>]` and `ack <id> [--result <json>] [--error <text>]` to `src/operator/cli.ts` and its usage; `--error` posts to `nack`
- [x] 3.7 Tests in `test/slice/outbox.test.ts` over `test/slice/harness.ts`: list in order, ack removes from the list and stores the result, nack twice keeps it pending with `attempts` 2, a third nack marks it failed and `trackerErrors` names it, `outboxPending` in status and digest, unknown id is 404, `PUT /v1/graph` with `tracker` records it and status reports it; CLI `outbox` and `ack` in `test/slice/operator.test.ts`

## 4. Operator MCP tools and import

- [x] 4.1 Register `outbox` (`after?`, `limit?`) and `ack` (`id`, `result?`, `error?`) in `src/operator/mcp-server.ts`; `ack` forwards to `ack` or `nack` by which argument is present and errors locally when neither or both are given
- [x] 4.2 Add both tools to `TOOL_NAMES` in `src/operator/mcp-server.ts` and to `USAGE` in `src/operator/mcp.ts`
- [x] 4.3 Export `trackerSchema` (`kind: linear | atlassian`, `workspace?`) from `src/import/mapping.ts`, accept `tracker` in `importInputSchema` without changing the mapping, and have `import_issues` pass it to `PUT /v1/graph`
- [x] 4.4 Tests in `test/slice/operator-mcp.test.ts`: tool list equals `TOOL_NAMES` with nineteen entries; `import_issues` with `tracker` then `status` reports it; `outbox` then `ack` with a result; `ack` with an error nacks; `ack` with neither is a local error; `test/import/mapping.test.ts`: `tracker` validated and passed through, mapping output unchanged

## 5. Slice through a fake tracker and crash coverage

- [x] 5.1 Write `test/slice/fake-tracker.ts`: an in-memory tracker with issues (state by type, comments with ids and timestamps) and `drainOnce(h, tracker)` that does what the run skill does: `GET /v1/outbox`, map `setState` by type, marker check before posting, ack with the vendor id, nack with the error, stop on an issue after its first error
- [x] 5.2 Write `test/slice/tracker-sync.test.ts` on the tracked fixture with scripted agents: assert the per-issue state and comment sequences through first launch, question (comment), answer from the terminal, exhaustion (comment), publication (done), milestone submitted (comment), accept (comment plus done, parent done), and cancel; the same scripted run without a tracker leaves the outbox empty
- [x] 5.3 Add to `test/slice/tracker-sync.test.ts`: a drainer that dies between post and ack, then a second drain that finds the marker and acks without a second comment; a tracker that rejects a state three times so the effect ends `failed` and in `trackerErrors`; a later effect for the same issue not applied in the drain that nacked
- [x] 5.4 Add to `test/slice/tracker-sync.test.ts`: `doneAt: milestoneAccepted` end to end with task issues flipping at accept; the answer relay, where a human comment under the question comment is relayed through `answer` and a second relay is refused with 409
- [x] 5.5 Tests: extend `test/crash/crash.test.ts` and `test/crash/harness.ts` with the tracked fixture and a sixth invariant, that after any crash point the outbox holds exactly one row per derivable transition in the event log, matching an uninterrupted run

## 6. Skills and documentation

- [x] 6.1 Update `hosts/claude-code/skills/import/SKILL.md`: pass `tracker: { kind, workspace }` to `import_issues`, kind from the connector used, workspace from the Linear workspace or Jira site when known
- [x] 6.2 Add a "drain the outbox" step to `hosts/claude-code/skills/run/SKILL.md` after every `wait` return: call `outbox`, apply in order, map `setState` by state type with the Linear (`started`, `completed`, `canceled`) and Jira (status category In Progress, Done, canceled-type when present, else comment) tables, marker check before posting, `ack` with the vendor id, `ack` with the error on failure, skip the rest of that issue, report a one-line count
- [x] 6.3 Add a "relay comment answers" step to `hosts/claude-code/skills/run/SKILL.md`: when the policy's `answersFromComments` is true, for each task in `openQuestions` read the issue's comments, ignore marked ones, relay the first human comment after the latest marked one through `answer`, remember relayed comment ids, report a 409 instead of retrying
- [x] 6.4 Document tracker sync in `README.md`: what is mirrored, the `tracker` config keys, the outbox routes and tools, the marker, and how to answer from the tracker
- [x] 6.5 Tests: `claude plugin validate --strict hosts/claude-code` passes; `test/e2e/plugin.test.ts` asserts the run skill names `outbox`, `ack`, and the marker check; an opt-in manual check against a sandbox Linear workspace is described in the README and is not part of `npm test`
