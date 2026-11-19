## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Six of the seven requirements of `tracker-sync` are over the limit: "Durable outbox" (625 characters), "Tracker policy" (608), "State effects" (803), "Done semantics" (585), "Comment effects" (1282) and "Drainer contract" (822). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-155).

## What Changes

- MODIFIED "Durable outbox", "Tracker policy", "State effects", "Done semantics", "Comment effects" and "Drainer contract": each keeps its header and every scenario unchanged, and its description is cut to one behavior (429, 408, 297, 364, 286 and 375 characters).
- Fourteen ADDED requirements hold the moved sentences, each with a description of at most 500 characters and at least one WHEN/THEN scenario of its own. "Effect kinds" is not over the limit and is not touched.
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped: 31 in the original descriptions, 34 in the cut and ADDED ones (16 cut + 18 ADDED). The three extra come from the lead-in "The daemon SHALL derive a `comment` when" repeated in the parts of the split sentence of "Comment effects".

### Split sentence

The first sentence of "Comment effects" ("The daemon SHALL derive a `comment` when: a task enters `waiting`, ...; a task becomes `blocked` for any other reason, ...; a gated milestone becomes `submitted`, ...; a milestone is accepted, ...; and a milestone is rejected, with the note.") is longer than 500 characters on its own. It is split at its semicolons, with its lead-in "The daemon SHALL derive a `comment` when" repeated in each part:

1. "The daemon SHALL derive a `comment` when a task enters `waiting`, or enters `blocked` with a question delivered through the fallback file, with the question verbatim and its options." stays in **Comment effects** (the colon after "when" is dropped at the joint, since one case follows).
2. "The daemon SHALL derive a `comment` when a task becomes `blocked` for any other reason than a question delivered through the fallback file, with the reason kind and message, the missing slots for `insufficientSpec`, and `whatWouldUnblock` when the last fail report carries one." moves to **Comment on other blocks**; "any other reason" is made explicit as "any other reason than a question delivered through the fallback file".
3. "The daemon SHALL derive a `comment` when a gated milestone becomes `submitted`, with a short notice: a first line naming the milestone, `ready for review`, `version <n> at <sha>` and the tag `milestone/<id>/v<n>`, then how to get the review (the `review` tool with the milestone id, or `orchestrator-ctl review <id>`), and no diff stat and no task lines." moves to **Comment on a submitted milestone**.
4. "The daemon SHALL derive a `comment` when: a milestone is accepted, with the sha and version; and a milestone is rejected, with the note." moves to **Comment on a milestone decision**.

No lead-in was added to text without SHALL: the one sentence of the original descriptions without SHALL or MUST ("The effect key and marker of the submitted comment are unchanged, ...") moves together with part 3, which carries SHALL.

### Moved sentences: "Durable outbox"

- "The daemon SHALL keep tracker-bound effects in a durable `outbox` table with `id`, `sourceSeq`, `taskId`, `kind`, `payload`, `status` of `pending`, `applied`, or `failed`, `attempts`, `result`, `error`, `createdAt`, and `appliedAt`." stays, unchanged.
- "Effects SHALL be derived from the daemon's own transitions and inserted in the same store transaction as the `transition` event they mirror, with `sourceSeq` equal to that event's sequence number." stays, unchanged.
- "The key `(sourceSeq, taskId, kind)` SHALL be unique so that derivation is idempotent." moves to **Idempotent effect key**, unchanged.
- "The daemon SHALL never contact a tracker; a drainer outside the daemon applies effects and acknowledges them." moves to **No tracker contact from the daemon**, unchanged.

### Moved sentences: "Tracker policy"

- "Effects SHALL be derived only when `tracker.enabled` permits: `never` yields none; `auto` (default) yields effects only when a tracker is recorded in the store; `always` yields effects whether or not one is recorded." stays, unchanged.
- "In every mode an effect SHALL be derived only for a node whose payload carries `url` or `trackerState`." stays, unchanged.
- "A run from a hand-written graph file with no tracker recorded SHALL produce no effects." stays, unchanged.
- "The policy, with `tracker.doneAt`, `parentInProgress`, `commentOnDone`, `commentOnFail`, `answersFromComments`, `maxAttempts`, and the run id, SHALL be reported to drainers alongside pending effects." moves to **Policy reported to drainers**, unchanged.

### Moved sentences: "State effects"

- "The daemon SHALL derive `setState inProgress` when a task enters `running`; `setState done` when a task becomes `done`, subject to `tracker.doneAt`; `setState cancelled` when a node becomes `cancelled`; and `setState done` when a milestone becomes `done`, by acceptance or by automatic completion." stays, unchanged.
- "When `tracker.parentInProgress` is true (default) a task entering `running` SHALL also derive `setState inProgress` for every milestone that lists the task in its `deps`." moves to **Parent issue in progress**, unchanged.
- "A `setState` SHALL be derived only when its state differs from the last `setState` recorded in the outbox for that issue, so that a task's first launch yields one `inProgress`, retries and conflict relaunches yield none, the parent follows its first starting child, and a reopened task is set to `inProgress` again when it relaunches." moves to **State changes only on a new state**, unchanged.

### Moved sentences: "Done semantics"

- "With `tracker.doneAt` at `integration` (default) a task's `setState done` SHALL be derived when the task becomes `done`, that is when its work is published." moves to **Done at publication by default**, unchanged.
- "With `milestoneAccepted` a done task in the closure of a gated milestone SHALL instead derive a comment naming its published sha, and its `setState done` SHALL be derived when the first gated milestone whose closure contains it is accepted; a done task in no gated milestone's closure SHALL derive `setState done` at publication in either mode." stays; its reference "With `milestoneAccepted`" is made explicit as "With `tracker.doneAt` at `milestoneAccepted`", since the sentence that introduced `tracker.doneAt` moved out.
- "A milestone's own issue SHALL become `done` only when the milestone becomes `done`." moves to **Milestone issue done**, unchanged.

### Moved sentences: "Comment effects"

- The first sentence is split as listed under "Split sentence": part 1 stays, parts 2, 3 and 4 move to **Comment on other blocks**, **Comment on a submitted milestone** and **Comment on a milestone decision**.
- "A `waiting` to `blocked` transition that preserves the same question SHALL NOT derive a second comment." stays, unchanged.
- "A done task SHALL derive a comment only when `tracker.commentOnDone` is true (default false) or `doneAt` is `milestoneAccepted`; a `failed` transition SHALL derive a comment with the failure reason only when `tracker.commentOnFail` is true (default false)." moves to **Optional done and failure comments**, unchanged.
- "The effect key and marker of the submitted comment are unchanged, so an effect derived before the notice and still pending keeps its long body." moves to **Comment on a submitted milestone**, unchanged.

### Moved sentences: "Drainer contract"

- "A drainer SHALL read pending effects in `id` order and apply each through the tracker." stays, unchanged.
- "It SHALL acknowledge an applied effect with the vendor result, and SHALL reject a failed one with the error." stays, unchanged.
- "On rejection the daemon SHALL increase `attempts` and keep the effect `pending` while `attempts` is below `tracker.maxAttempts` (default 3), and SHALL mark it `failed` at the cap." stays, unchanged.
- "Effects for one issue SHALL be applied in `id` order; after a rejection the drainer SHALL leave that issue's later effects for the next drain." moves to **Per-issue effect order**, unchanged.
- "Before posting a comment the drainer SHALL look for an existing comment on the issue carrying the same marker and, when found, SHALL acknowledge with that comment's id instead of posting." moves to **Marker lookup before posting**, unchanged.
- "An acknowledgement for an effect that is already `applied` SHALL change nothing and SHALL return the stored result." moves to **Repeated acknowledgement**, unchanged.

### Sources of the new scenarios (at base c4fa94d)

- **Idempotent effect key**, "Duplicate key keeps one row": `test/state/outbox.test.ts` ("a duplicate key keeps one row").
- **No tracker contact from the daemon**, "Effects wait for a drainer" and "A drainer acknowledges an applied effect": `test/slice/outbox.test.ts` ("lists, acknowledges, rejects with retry and cap, ..."); `src/tracker/effects.ts` derives effects without any tracker client; `test/slice/fake-tracker.ts` (`drainOnce`) is the drainer outside the daemon.
- **Policy reported to drainers**, "Outbox listing carries the policy": `test/slice/outbox.test.ts` (the `policy` of `GET /v1/outbox`).
- **Parent issue in progress**, "Milestone follows its starting task": `test/loop/tracker-effects.test.ts` ("the parent issue follows its first starting child, unless parentInProgress is off"), `test/fixtures/graphs/tracked.yaml` (MVP deps T3, T4).
- **State changes only on a new state**, "Conflict relaunch derives no state": `test/loop/tracker-effects.test.ts` ("derives one inProgress per task across a retry and a conflict relaunch, ..."); "Reopened task is set in progress again": same file ("a reopened task is set in progress again when it relaunches").
- **Done at publication by default**, "Task issue closes at publication": `test/loop/tracker-effects.test.ts` ("done at integration: the task flips at publication, the parent at acceptance, with review comments").
- **Milestone issue done**, "Submitted milestone stays in progress": same test as above.
- **Comment on other blocks**, "Insufficient brief is mirrored": `test/loop/tracker-effects.test.ts` ("mirrors insufficient briefs with the missing slots").
- **Comment on a submitted milestone**, "Notice stays short for a large milestone": `test/loop/tracker-effects.test.ts` ("the ready-for-review comment stays short for a milestone of 24 tasks with long summaries and a long stat").
- **Comment on a milestone decision**, "Acceptance is mirrored": `test/loop/tracker-effects.test.ts` ("done at integration: ..."); "Rejection is mirrored": same file ("mirrors a question once, exhaustion with what would unblock, and a rejection").
- **Optional done and failure comments**, "Comments on when configured": `test/loop/tracker-effects.test.ts` ("completion and failure comments are off by default and on when configured").
- **Per-issue effect order**, "Held effect applies after the earlier one fails": `test/slice/tracker-sync.test.ts` ("a drainer that died after posting is reconciled by the marker; rejections retry to the cap and hold later effects for the issue").
- **Marker lookup before posting**, "Drainer that died after posting": same test; `test/slice/fake-tracker.ts` (`drainOnce` looks up the marker).
- **Repeated acknowledgement**, "Second acknowledgement returns the first result": `test/slice/outbox.test.ts` (the second ack with `{ stateId: 'other' }`), `test/state/outbox.test.ts` ("ack stores the result and the time; a second ack changes nothing").

## Capabilities

### New Capabilities

### Modified Capabilities

- `tracker-sync`: six long requirements cut to one behavior each; fourteen requirements added for the moved sentences.

## Impact

Spec text only; no code changes.
