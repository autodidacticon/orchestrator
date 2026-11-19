## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Ten of the 27 requirements of `crash-recovery` are over the limit. This change splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-146).

## What Changes

- MODIFIED, ten requirements: "Launch lifecycle records", "Recovery per boundary", "Fencing", "Named crash points", "Outbox effects", "Cascade is resumable", "Claim boundaries", "Store transactions", "Idle exit and revival" and "Attachment end is durable". Each keeps its header and every scenario, names and texts unchanged; its description is cut to one behavior of at most 500 characters.
- ADDED, 28 requirements, one per behavior removed from a MODIFIED description. Each holds the moved sentences, unchanged or with only their references made explicit, and one new scenario.
- The bullets moved out of "Recovery per boundary" keep their wording under the lead-in "In recovery on start:", which names the recovery they belong to; the sentences moved from its `publishing` bullet into "Recovery of a publishing job with pushing on" are led by "In recovery on start, for a verifier job in `publishing`:". These lead-ins add no requirement.
- No SHALL or MUST is dropped: the ten original descriptions hold 82, and the cut and ADDED descriptions hold 82. Nothing is removed or renamed, and no other requirement changes.

### Moved sentences

Each sentence moved out of a MODIFIED description, and the ADDED requirement that now holds it. Every other sentence stays in its MODIFIED description; "These rules hold for every backend" stays in "Store transactions" as 'The rules of "Store transactions", "Nested transactions", "Constraint violations roll back" and "Existing store opens unchanged" hold for every backend'.

### Launch lifecycle records

- "The row written at `preparing` SHALL carry the runner kind, model, and effort fixed for the launch, so that liveness, reaping, and usage after a restart reach the runner the launch was prepared for; a row without a kind SHALL read as `claude-code`" → "Launch row fixes the runner"

### Recovery per boundary

- "a launch in `live` whose process is alive SHALL be adopted with its lease intact" → "Recovery of a live launch"
- "a launch in `live` whose process is dead and whose fallback file exists SHALL have the file applied" → "Recovery of a live launch"
- "a launch in `live` whose process is dead with no fallback file, while its task is `running`, SHALL be failed through the same path as a death the tick observes (task-lifecycle "Retry and exhaustion"): it is recorded as a `launch.failed` event, and the task ends as `failed` with `attempts` increased unless the runner diagnoses `startupContended` within the `health.contendedRetries` allowance, in which case the task returns to `unstarted` with `attempts` unchanged" → "Recovery of a dead launch without a fallback file"
- "a verifier job in `queued`, `checking`, or `verified` SHALL have any temporary worktree removed and SHALL restart from `queued`" → "Recovery of verifier jobs before publishing"
- "a verifier job in `publishing` SHALL be resolved by inspecting the integration branch for the launch trailer: present means record `published` and `done`, absent means requeue" → "Recovery of a publishing job"
- "With `git.pushIntegration` on, recovery SHALL fetch and inspect origin's integration branch first" → "Recovery of a publishing job with pushing on"
- "A trailer only on the clone, at the job's `squashSha`, while origin is still at the job's `expectedHead`, SHALL be pushed once with that lease and recorded `published`" → "Recovery of a publishing job with pushing on"
- "A lease that no longer holds SHALL undo the local compare-and-swap and requeue, as SHALL an origin that cannot be reached" → "Recovery of a publishing job with pushing on"
- "a milestone tag SHALL be re-created idempotently, and with `git.pushIntegration` on, pushed to origin" → "Recovery of milestone tags"

### Fencing

- "A call accepted before its launch was revoked SHALL check again before it records anything: a submit that was sealing its worktree when the launch was revoked SHALL return 401, and one whose task's lease moved to another launch SHALL return 409, with no task state changed" → "Fencing rechecked before recording" (reference made explicit)

### Named crash points

- "The named points SHALL be `launch.afterRow`, `launch.afterWorktree`, `launch.afterSpawn`, `launch.afterPid`, `launch.afterClaimable`, `claim.afterRecord`, `api.afterEventCommit`, `verify.afterQueued`, `verify.afterRebase`, `verify.afterCheck`, `verify.afterSquash`, `verify.afterPublish`, `milestone.afterTag`, `cascade.afterPlan`, and `tick.afterPhase<n>` for each phase" → "Crash point names"

### Outbox effects

- "A daemon crash at any instant SHALL lose no effect and SHALL duplicate none, because derivation commits with the transition and the unique key refuses a second row" → "Outbox effects are neither lost nor duplicated"
- "A drainer crash between the tracker write and the acknowledgement SHALL be resolved on the next drain: a comment by the marker check, a state by the idempotence of setting the same state again" → "Drainer crash resolved on the next drain"

### Cascade is resumable

- "The code SHALL call `crashPoint('cascade.afterPlan')` between recording the plan and the first reset, and `cascade.afterPlan` SHALL be a named crash point" → "Cascade crash point"
- "After a crash at `cascade.afterPlan` or at any tick phase during a cascade, followed by a restart, the convergence invariants SHALL hold with trailer commits counted per published launch" → "Cascade crashes converge"

### Claim boundaries

- "The claim's external effect is its response" → "Claim recorded before its response"
- "Its durable record SHALL be one transaction that sets the launch to `live` with the worker id, resets the lease, and appends the event, committed before the response is sent, and a lost response SHALL be repaired by the idempotent re-claim" → "Claim recorded before its response"
- "The named crash points SHALL additionally include `launch.afterClaimable`, after the row becomes claimable, and `claim.afterRecord`, after the claim transaction and before the response" → "Claim crash points"
- "On start, recovery SHALL keep a `claimable` launch claimable, verifying that its worktree exists and re-preparing it when missing; SHALL keep a live launch held by a worker while its lease is unexpired, judging liveness by the lease rather than by a process; and SHALL expire an expired one as the tick would, keeping it with progress and failing it with reason `leaseExpired` without (see "Claimed lease expired while the daemon was down")" → "Recovery of claimable and claimed launches"
- "Sweeps SHALL treat claimable launches as live" → "Sweeps keep claimable launches"
- "The convergence invariants SHALL hold for the crash matrix run in `pull` mode with scripted workers" → "Crash matrix in pull mode"

### Store transactions

- "A `transaction` call made while a transaction is open SHALL nest: when the inner function throws, only the inner function's writes are undone and the outer transaction continues; when the outer function throws, the inner function's writes are undone with it" → "Nested transactions"
- "A primary key or unique violation SHALL throw an `Error` whose message names the constraint, and the transaction it happened in SHALL roll back" → "Constraint violations roll back"
- "An existing store SHALL open unchanged" → "Existing store opens unchanged"
- "For the SQLite store (and a journaled store's SQLite image), a transaction SHALL be one SQLite transaction and a nested call a savepoint" → "SQLite transactions and savepoints"
- "The store SHALL open in WAL mode with `synchronous = NORMAL` and a busy timeout of five seconds, so that a reader in another process never blocks the writer and a writer that finds the database locked by another connection waits for it rather than failing at once" → "SQLite store open settings" (reference made explicit)
- "The busy timeout SHALL be set before the switch to WAL mode, and opening the store SHALL retry the WAL switch and the schema creation while SQLite reports `SQLITE_BUSY`, for up to the same five seconds, because SQLite returns `SQLITE_BUSY` from the switch without calling the busy handler when two connections open a new file at once" → "WAL switch retried while busy"

### Idle exit and revival

- "A daemon started afterwards SHALL run the same recovery as after any stop and SHALL find nothing to adopt or repair: a `submitted` milestone keeps its `integrationSha`, `reviewVersion`, and tag; a `blocked` task keeps its question and answer; pending outbox effects stay pending; parked launches stay `claimable` with their worktrees re-prepared when missing; and the next tick proceeds from the stored state" → "Revival after an idle exit" (reference made explicit)
- "The exit record SHALL NOT be consulted by recovery" → "Revival after an idle exit"
- "The crash matrix SHALL keep passing with the default idle window, because every run in it finishes well inside it" → "Crash matrix inside the idle window"
- "A daemon in container mode (`daemon.idleExitMs: 0`, reached through a non-loopback `ORCH_URL`) SHALL never exit idle and SHALL never be revived by a client spawning a local process; a signalled stop in that mode SHALL be recovered like any graceful stop, and a check abandoned at the shutdown grace SHALL restart from `queued` (see specs/operator-control "Container mode")" → "No idle exit in container mode"

### Attachment end is durable

- "The kept release SHALL preserve uncommitted work on the launch branch before the launch is ended, so a crash after the commit and before the transition leaves the branch with the work and the launch still live, and the next reconcile completes the release" → "Kept release preserves work first"

### Evidence for the new scenarios

Each new scenario states behavior the code has at the base commit (e2e2197):

- "Row without a kind" ("Launch row fixes the runner"): `src/state/store.ts` (`runnerOf`).
- "Dead launch with a fallback file" ("Recovery of a live launch"): `src/launch/recovery.ts` (`readFallback`, `sealFallback`, `applyFallback`, end reason `recovered-dead`).
- "Dead launch ended at restart" ("Recovery of a dead launch without a fallback file"): `test/health/contended.test.ts`.
- "Checking job restarts" ("Recovery of verifier jobs before publishing"): `src/launch/recovery.ts` (`sweepTemp`, `checking` and `verified` set to `queued`).
- "Published at its squash" ("Recovery of a publishing job"): `src/launch/recovery.ts` and `src/verify/verifier.ts` (`recoverPublishing`).
- "Origin moved before the push" ("Recovery of a publishing job with pushing on"): `test/slice/origin.test.ts` ("a push lost to a moved origin at recovery undoes the local swap and republishes on the new head").
- "Tag missing at restart" ("Recovery of milestone tags"): `src/launch/recovery.ts` (the `tagged:<id>:<version>` record and `tagSafely`).
- "Lease moved while the submit was sealing" ("Fencing rechecked before recording"): `src/loop/orchestrator.ts` (the submit transaction after `sealSubmission`, 409 `notRunning`).
- "Every named point exits" ("Crash point names"): `src/crash.ts` (`CRASH_POINTS`, exit code 137) and `test/crash/crash.test.ts`.
- "Second row for the same key refused" ("Outbox effects are neither lost nor duplicated"): `test/state/outbox.test.ts` ("a duplicate key keeps one row").
- "Marker already on the issue" ("Drainer crash resolved on the next drain"): `hosts/claude-code/skills/run/SKILL.md` (the drainer's marker check) and `test/slice/tracker-sync.test.ts`.
- "Plan recorded when the point fires" ("Cascade crash point"): `src/loop/orchestrator.ts` (`cascadeReopen`) and `test/loop/cascade.test.ts`.
- "Crash at a tick phase during a cascade" ("Cascade crashes converge"): `test/crash/crash.test.ts` ("cascade crash scenario").
- "Re-claim by the holding worker" ("Claim recorded before its response"): `src/loop/orchestrator.ts` (`claim`, the held-launch path).
- "Crash point after the claim transaction" ("Claim crash points"): `src/loop/orchestrator.ts` (`crashPoint('claim.afterRecord')` after the claim transaction).
- "Claimed leases expired while the daemon was down" ("Recovery of claimable and claimed launches"): `test/slice/claim-recovery.test.ts`.
- "Parked worktree kept by the startup sweep" ("Sweeps keep claimable launches"): `src/launch/recovery.ts` (the sweep's live set includes `claimable`).
- "Pull-mode crash at a verifier point" ("Crash matrix in pull mode"): `test/crash/crash.test.ts` ("pull-mode crash matrix").
- "First launch kept" ("Constraint violations roll back"): `test/state/sqlite.test.ts` ("a duplicate launch id throws and rolls back the transaction").
- "Recorded tracker and run id kept" ("Existing store opens unchanged"): `test/state/outbox.test.ts` ("an existing store opens with an empty outbox and keeps the tracker and run id").
- "Rolled-back level never reaches the sink" ("Nested transactions"): `test/state/journal.test.ts` ("one top-level transaction is one batch ...").
- "Nested call opens a savepoint" ("SQLite transactions and savepoints"), "Settings of an opened store" ("SQLite store open settings") and "Busy past five seconds" ("WAL switch retried while busy"): `src/state/sqlite.ts` (`transaction`, the constructor, `execRetryingBusy`).
- "Finished run revived" ("Revival after an idle exit"): `test/runs/lifecycle.test.ts` ("exits on its own when idle, records why, and is revived with its state intact").
- "Crash runs under the default window" ("Crash matrix inside the idle window"): `src/config.ts` (`idleExitMs` default 600000) and `test/crash/harness.ts`, `test/crash/crash.test.ts`.
- "Signalled stop during a check" ("No idle exit in container mode"): `test/slice/container.test.ts`.
- "Uncommitted work committed on release" ("Kept release preserves work first"): `test/slice/claim.test.ts` ("a kept release preserves uncommitted work on the branch ...").

## Capabilities

### New Capabilities

### Modified Capabilities

- `crash-recovery`: ten long requirements cut to one behavior each, and 28 requirements added for the behaviors moved out of them.

## Impact

Specification only: no code, test or configuration changes. The change is archived after the milestone review.
