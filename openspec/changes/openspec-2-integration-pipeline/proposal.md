## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Nine of the 31 requirements of `integration-pipeline` are over the limit (9611 characters and 89 occurrences of SHALL or MUST in all). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-162).

## What Changes

- Nine requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept |
  |---|---|---|---|
  | Repository layout | 686 | 389 | 2 |
  | Base selection | 552 | 253 | 2 |
  | Check and verified tree | 955 | 338 | 5 |
  | Compare-and-swap publication | 668 | 281 | 3 |
  | Milestone tagging | 735 | 354 | 4 |
  | Check environment | 1168 | 438 | 3 |
  | Origin as source of truth | 1640 | 377 | 4 |
  | Prepare command before the check | 1569 | 478 | 7 |
  | Failed check across a gap | 1638 | 313 | 3 |

- 28 requirements are ADDED, one for each behavior moved out of those descriptions. Each has a name `integration-pipeline` does not have yet, a description of at most 500 characters, and at least one scenario of its own with a WHEN and a THEN step.
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped: the nine original descriptions hold 89; the cut descriptions hold 32 and the ADDED descriptions 57.
- No sentence of an original description is longer than 500 characters on its own, so no sentence is split at its semicolons.

Below, every sentence of each original description is listed: it either stays in the MODIFIED description or moves to exactly one ADDED requirement. "Unchanged" means word for word. Where a reference is made explicit, the change is stated.

### Moved sentences: "Repository layout"

- Stay unchanged: "The orchestrator SHALL manage one repository per instance.", "Its primary clone SHALL keep the integration branch checked out and SHALL never be used for work.", "Each launch SHALL get its own worktree ...", "The worktree SHALL be removed after the launch ends and the branch SHALL be retained."
- "With `git.pushIntegration` on, the clone SHALL have a remote `origin` whose integration branch is the source of truth (see "Origin as source of truth"); the clone's integration branch SHALL follow it and SHALL never hold a commit origin lacks except between a local compare-and-swap and its push." moves to **Clone follows origin**, unchanged.

### Moved sentences: "Base selection"

- Stay unchanged: "A launch SHALL start from the integration head observed at claim time, ...", "Because every dependency is `done` before a task is ready, the base MUST already contain the dependencies' published work."
- "With `git.pushIntegration` on, the integration head SHALL be read from `refs/remotes/origin/<branch>`, ...; while the clone's branch is strictly ahead of origin's, the clone's head SHALL be used instead." moves to **Integration head read from origin**, unchanged.

### Moved sentences: "Check and verified tree"

- Stay unchanged: "The verifier SHALL run the effective check command, ...", "A non-zero exit or a timeout SHALL fail the task ...", "The check command SHALL apply in every runner mode."
- "While `checkCommand` is unresolved, a `queued` job whose sealed sha differs from its base sha SHALL NOT start checking: ..." moves to **Unresolved check command holds the job**, unchanged.
- "A `queued` job whose sealed sha equals its base sha, a declared no-op, SHALL NOT be held: ..." moves to **Declared no-op is not held**, unchanged.
- "A job already `checking` when the command changes SHALL finish with the command it started with." moves to **Check command kept for a running check**, unchanged.

### Moved sentences: "Compare-and-swap publication"

- Stay unchanged: "Publication SHALL update the integration ref with a compare-and-swap ...", "If the expected head no longer matches, the job SHALL return to `queued`.", "`publishedSha` and the task's `done` transition SHALL be recorded in one transaction."
- "With `git.pushIntegration` on, the expected head SHALL be origin's head after the job's fetch, ...; a push that is rejected or fails SHALL undo the local compare-and-swap and return the job to `queued`, so the next run rebases onto origin's new head." moves to **Publication pushed with a lease**, unchanged.

### Moved sentences: "Milestone tagging"

- Stay unchanged: "When a gated milestone becomes `submitted`, the orchestrator SHALL tag ...", "Tag creation SHALL be idempotent.", "With `git.pushIntegration` on, the tag SHALL also be pushed to origin without force.", "The push outcome SHALL be returned and never thrown, ..."
- "The local tag SHALL be recorded as `tagged:<id>:<version>` once it exists, and the push separately as `tagPushed:<id>:<version>`." moves to **Milestone tag records**, unchanged.
- "A push that fails SHALL be retried on every tick for a gated milestone in `submitted` or `done` until it lands." moves to **Milestone tag push retried**, unchanged.
- "A tag that origin holds at another sha SHALL never be moved: it SHALL be reported once as a `milestone.tagConflict` event and not retried." moves to **Milestone tag held at another sha**, unchanged.

### Moved sentences: "Check environment"

- Stay unchanged: "The check command SHALL run with the same environment isolation as a spawned agent: ...", "Repository code run by the check SHALL NOT be able to discover or stop any daemon of the user's through the run directory layout."
- "While the daemon withholds (specs/state-backend "Withholding follows the store": always on a Postgres store), `DATABASE_URL`, ... SHALL be removed too." moves to **Check environment while withholding**, unchanged.
- "While it does not withhold (a SQLite store with no Postgres input), they SHALL reach the check unchanged, so a project's check keeps its own database variables." moves to **Check environment without withholding**, with its references made explicit: "it" becomes "the daemon", and "they" becomes "`DATABASE_URL`, `DATABASE_URL_FILE`, every libpq connection variable named in `LIBPQ_VARS` and every variable whose value is the resolved store URL".
- "While the daemon withholds, it SHALL NOT be able to reach the orchestrator's state database through its environment." moves to **Check cannot reach the state database**, with "it" made explicit as "repository code run by the check".
- "The check runs as the daemon's user, so it can still read what specs/state-backend "Store credentials a child can still reach" lists; this requirement does not cover that." moves to **Check cannot reach the state database**, unchanged. "this requirement" now names that ADDED requirement, which is the one about reaching the store.

### Moved sentences: "Origin as source of truth"

The original description holds a list under "With it on, the following SHALL hold:". The cut description keeps that sentence and the list's first sentence. Each sentence that moves out of the list starts with "With `git.pushIntegration` on, ", which makes explicit the condition "With it on, the following" gave it (the sentence's first word is then lower case).

- Stay unchanged: "The configuration block `git` SHALL hold ...", "With `pushIntegration` off, no git command the orchestrator runs SHALL name or contact a remote.", "With it on, the following SHALL hold:", "The remote `origin` of the daemon's clone SHALL be the source of truth for the integration branch."
- "When `originUrl` is set, the remote SHALL be added or re-pointed to it before first use." moves to **Origin remote configured before use**, with the condition prefix and "the remote" made explicit as "the remote `origin`".
- "When it is unset and the clone has no `origin`, every operation that needs origin SHALL fail naming the missing setting." moves to **Origin remote configured before use**, with "it" made explicit as "`originUrl`".
- "All fetches and pushes of one daemon SHALL run one at a time." and "A fetch SHALL update `refs/remotes/origin/<branch>` only, without tags." move to **Remote commands run one at a time**, the first with the condition prefix, the second unchanged.
- "Before a verifier job observes its expected head, the verifier SHALL fetch." and "A fetch that fails SHALL requeue the job without spending an attempt, and the `verify.requeued` event and the daemon log SHALL carry the reason." move to **Fetch before the expected head**, the first with the condition prefix, the second unchanged.
- "When the job's `Orchestrator-Launch` trailer is already on origin, the job SHALL be published at that commit without a further push." and "While a push of a squash is in flight, base selection SHALL NOT use that squash." move to **Launch already on origin**, the first with the condition prefix, the second unchanged.
- "Otherwise the verifier SHALL bring the clone's integration branch to origin's:" with its three items moves to **Clone brought to origin**, with the condition prefix and "Otherwise" made explicit as "when the job's `Orchestrator-Launch` trailer is not on origin". The three items are unchanged.
- "After a successful push, `refs/remotes/origin/<branch>` SHALL point at the pushed commit." moves to **Tracking ref after a push**, with the condition prefix.

### Moved sentences: "Prepare command before the check"

- Stay unchanged: "With the top-level file key `prepareCommand` set, the verifier SHALL run it ...", "The value SHALL be read once when the verifier is built; it is a file key with no override.", "With `prepareCommand` unset the verifier SHALL behave as it does without this requirement."
- "A prepare command that exits non-zero, or whose exit code is null, SHALL fail the job with kind `checkFailed` and message `prepare command exited <code>`." moves to **Prepare command failures**, unchanged.
- "One that exceeds `prepareTimeoutMs` SHALL be killed and SHALL fail the job with kind `checkTimeout` and message `prepare command exceeded <ms>ms`." moves to **Prepare command failures**, with "One" made explicit as "A prepare command".
- "On either failure the check command SHALL NOT run, an attempt SHALL be spent ..., so the first line of the output names the prepare command." moves to **Prepare failure output**, with "either failure" made explicit as "either failure of the prepare command, by its exit code or by `prepareTimeoutMs`,".
- "The verifier's prepare command SHALL have no failure count, backoff or block of its own; `maxAttempts` bounds it." moves to **Prepare command bounded by attempts**, unchanged.
- "The published tree SHALL be the one read before the prepare command runs ("Check and verified tree"), so nothing the command writes is published, and the verifier SHALL NOT test whether the command left the worktree clean." moves to **Prepare command output not published**, unchanged.
- "A command that has not closed 2000 ms after the kill at `prepareTimeoutMs`, or that exited while another process still holds its output pipe, SHALL be recorded then as a timeout." moves to **Prepare command that does not close**, with "A command" made explicit as "A prepare command".

### Moved sentences: "Failed check across a gap"

- Stay unchanged: "A verifier run that ends `failed` with kind `checkFailed` or `checkTimeout`, or that throws, ... SHALL be put back to `queued` instead of `failed`, once per job.", "No attempt SHALL be spent and the task SHALL stay `submitted`.", ""Check and verified tree" is unchanged."
- "The run overlapped a gap when ...; both instants SHALL be read after a note of the clock, ..., and the verifier SHALL keep no clock of its own." moves to **Gap overlap read from the daemon clock**, with "The run" made explicit as "A verifier run".
- "In one store transaction the daemon SHALL append `verify.requeued` ... and set its `gapRequeues` to 1." and "Push retry state SHALL NOT change." move to **Gap requeue record**, unchanged.
- "The count SHALL be kept on the job row and SHALL NOT be cleared when the job is re-queued for another reason." moves to **Gap requeue count**, with "The count" made explicit as "The `gapRequeues` count".
- "A failure of a job whose `gapRequeues` is 1 SHALL be written `failed` as before, gap or no gap." moves to **Gap requeue count**, unchanged.
- "The re-run SHALL start like any queued job, after the hold that follows the gap (specs/health-monitoring "Hold after a gap")." moves to **Re-run after a gap requeue**, with "The re-run" made explicit as "The re-run of a job re-queued across a gap".
- "A `conflict`, `published` or `requeue` outcome, another failure kind, a dropped job and a fatal store SHALL be handled as before, and `checkTimeoutMs` SHALL still count wall time." moves to **Outcomes outside the gap rule**, unchanged.
- "With `health.gapAfterMs` at 0 there are no gaps and this rule re-queues nothing." moves to **Outcomes outside the gap rule**, with "this rule" made explicit as "the rule of "Failed check across a gap"".

### Where the new scenarios come from

Each new scenario states behavior the code has at the change's base commit (c384ea1):

- Clone follows origin: `test/slice/origin.test.ts` ("every published trailer commit is on origin, ..."), `src/verify/verifier.ts` (`run`: the local swap is undone when the push fails).
- Integration head read from origin: `src/workspace/origin.ts` (`maybeFetch`: a failed fetch keeps the tracking ref), `src/workspace/git-workspace.ts` (`integrationHead`: the clone's head while it is ahead).
- Unresolved check command holds the job, Declared no-op is not held, Check command kept for a running check: `test/slice/config.test.ts` ("verification while the check command is unresolved", its three tests).
- Publication pushed with a lease: `src/verify/verifier.ts` (`run`, step 4: `pushBranch` with the lease, `updateRefCas` back to the expected head, `pushRequeue`), `test/slice/origin.test.ts` ("a commit pushed to origin between verification and publication fails the lease, ...").
- Milestone tag records, Milestone tag push retried, Milestone tag held at another sha: `src/loop/tick.ts` (`pushMilestoneTags`, `recordTagPush`), `test/slice/origin.test.ts` ("a milestone tag push that fails is retried until the tag is on origin", "a tag origin already holds at another sha is never moved and is reported once").
- Check environment while withholding, Check cannot reach the state database: `test/runs/child-env.test.ts` ("childEnv and withoutStore drop DATABASE_URL, ORCH_RUN_ID and every variable whose value is the withheld URL", "a check command and a spawned agent that print their environment see neither ...").
- Check environment without withholding: `test/runs/child-env-sqlite.test.ts` ("with store.kind: sqlite written in the file, ORCH_RUN_ID is no Postgres input: ...").
- Origin remote configured before use: `src/workspace/origin.ts` (`ensure`), `test/slice/origin.test.ts` ("pushing on without an origin remote or URL fails the job naming the setting").
- Remote commands run one at a time: `src/workspace/origin.ts` (`serial`, `fetchNow` with `--no-tags`).
- Fetch before the expected head: `src/verify/verifier.ts` (`startFromOrigin`), `test/slice/origin-failures.test.ts` ("ORC-97 criterion 1: a fetch that cannot reach origin is retried ...").
- Launch already on origin: `test/slice/origin-failures.test.ts` ("a push that had landed before the kill is found by its trailer once origin answers, and nothing is pushed again"), `src/workspace/git-workspace.ts` (`integrationHead`: `origin.inFlight`).
- Clone brought to origin: `src/verify/verifier.ts` (`startFromOrigin`, `fastForwardTo`).
- Tracking ref after a push: `src/workspace/origin.ts` (`pushBranch`: `update-ref` of the tracking ref).
- Prepare command failures, Prepare failure output, Prepare command that does not close: `src/verify/verifier.ts` (`run`: the prepare messages and output; `runCheck` with `closeWaitMs: 2000`), `test/slice/verifier.test.ts` (the prepare command tests), `test/slice/prepare.test.ts` ("runCheck: ... a held pipe after exit resolves as timedOut after the bounded wait").
- Prepare command bounded by attempts: `src/verify/verifier.ts` (a prepare failure is an ordinary `failed` outcome), `test/slice/verifier.test.ts` ("a non-zero exit fails the job as checkFailed, spends an attempt, ...").
- Prepare command output not published: `test/slice/verifier.test.ts` ("runs before the check in the temporary worktree, and nothing it installs is published").
- Gap overlap read from the daemon clock, Gap requeue record, Gap requeue count, Re-run after a gap requeue, Outcomes outside the gap rule: `test/loop/check-gap.test.ts` (all tests), `src/loop/orchestrator.ts` (`failVerifierJob`).

## Capabilities

### New Capabilities

### Modified Capabilities

- `integration-pipeline`: nine long requirements are split; 28 requirements are added from their descriptions.

## Impact

Spec text only. No code, test or other spec changes.
