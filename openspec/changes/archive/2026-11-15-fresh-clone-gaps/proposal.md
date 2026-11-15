## Why

The review of CLOUD-M2 v1 (2026-11-13, ORC-20 at 87508c7) found, by reading the code, gaps in startup on a fresh clone (ORC-91):

- `endLostClaim` moves a `waiting` claimed launch whose worktree is gone to `blocked` and stops, although its log says "task retried". An answer that already arrived is not replayed, as the dead-process branch replays it. The task stays blocked until someone unblocks it again.
- A kept release and a revision store `priorBranch` and `headSha` in the entry's carry, and the brief tells the next worker that the branch "holds the work so far". Launch branches live only in the clone, so after a restart without a volume the branch is gone. Recovery neither rewrites the carry nor records an event, so a kept release saves nothing across a restart and the brief points at nothing.
- `StoreGraphSource` keeps the stamp it last evaluated in memory, and `classifyReload` depends on task state. A proposal rejected today (T1 is running, say) is evaluated again at the next restart, possibly days later, and becomes active if it is now compatible, with nobody asking.
- Re-preparing a claimable launch is unguarded. If its base commit is not in the new clone, `git worktree add` throws inside `recover`, the daemon exits, and the pod crash-loops on the same durable state.
- `store.kind: postgres` with `git.pushIntegration` off is accepted silently. On a clone without a volume this records `done` for commits lost with the clone.
- `reviveDaemon` answers "pass --url" for a locally started Postgres run that is simply stopped.

## What Changes

- **A waiting claim whose worktree is lost.** Its launch ends with `worktreeLost`. With an answer already recorded, the task is retried at no cost with the question and answer in its next brief. Without one, the task stays `waiting`. An answer that arrives later retries it with the answer, because the launch it waited on is gone.
- **Context naming lost work.** At startup, recovery lists the clone's branches. An ended launch whose branch is missing has a lost branch. The commits named in stored context (`interrupted.headSha` and `wipCommit`, `revision.priorPublishedSha`) are checked as well. Each stored context that names a lost ref is rewritten, and each rewrite is recorded as a `recovery.workLost` event:
  - an `interrupted` context becomes `lostWork { priorLaunchId, reason }`;
  - a conflict loses `previousBranch`;
  - a revision loses `priorBranch` or `priorPublishedSha`.

  The scan runs right after the integration head is read, before any brief is composed: a relaunch of a `preparing` launch, or a parked launch prepared again. It runs again at the end of recovery, so the branches of launches recovery itself ended are included. The lost refs are kept for the daemon's life, so a context composed later (a reopen's revision) does not name them either. The brief says the work was lost with the previous clone and names no lost branch or commit.
- **Re-preparing a parked launch is guarded.** A claimable launch whose base commit the clone lacks fails its task as `worktreeLost`, uncharged and retryable, with `detail.baseLost` and the base sha. Its launch ends with `baseLost`. Any other failure to prepare it does the same, with launch end reason `prepareFailed`. The daemon does not exit.
- **A rejected proposal stays rejected until sent again.** The reload records the stamp and reasons of a stored proposal it rejects in kv `graph.rejectedStamp`. This covers incompatibility, insufficient briefs at ingest, and a document that does not parse. The store source does not evaluate that stamp again, in this daemon or a later one, so a restart never activates it. A restarted daemon still reports the standing rejection and its reasons in the status. A new `PUT /v1/graph` writes a new stamp, which is evaluated. The file source is unchanged: it re-evaluates a rejected file at every reload, so the file becomes active when it becomes compatible.
- **Postgres store with push integration off is warned about.** The daemon cannot tell a persistent volume from an emptyDir, and a locally started Postgres run keeps its clone on disk. So startup warns and does not refuse. The warning goes to the log and to a `config.warning` event with code `postgresWithoutPushIntegration`.
- **Reviving a local Postgres run.** A Postgres run whose run directory holds `daemon.json`, left by a daemon started from it, is revived like a local run: refused after a stop or signal, started after an idle exit or a crash. Only a Postgres run never started here is reported as remote.

## Capabilities

### Modified Capabilities
- `crash-recovery`: new "Waiting claim with a lost worktree", "Context naming lost work", "Re-preparing a parked launch".
- `graph-import`: new "Rejected proposal stays rejected".
- `state-backend`: new "Postgres store without push integration".
- `operator-control`: new "Revive a local Postgres run".

All requirements are ADDED. The requirements they extend ("Startup on a fresh clone", "Store selection", the proposed slot) are still in unarchived changes (`origin-source-of-truth`, `store-selection`).

## Impact

- Code:
  - `src/launch/recovery.ts`: `endLostClaim` (waiting cases), `scrubLostRefs`, guarded re-prepare (`failUnpreparable`).
  - `src/brief/lost.ts` (new): `scrubCarry`.
  - `src/brief/compose.ts`: `lostWork`, a conflict without `previousBranch`, a revision without `priorBranch`.
  - `src/loop/orchestrator.ts`: `lostRefs`, `briefInput` scrubs, `revisionContext` omits lost refs, `answer` retries a waiting task whose launch ended, `loadGraph` records a rejected stamp, `start` emits the warning.
  - `src/graph/source.ts`: `StoreGraphSource` skips a rejected stamp; `GraphSource.rejected`.
  - `src/config.ts`: `storeDurabilityWarning`.
  - `src/runs/lifecycle.ts`: `reviveDaemon` for a local Postgres run.
  - `src/state/status.ts`: `RevisionContext.priorBranch` and `ConflictContext.previousBranch` become optional, and `AttemptContext.lostWork` is added. The change is type-only, but the file is outside the task's listed scope.
- Not covered: a claimed launch already resumed to `running` with an uncollected `pendingAnswer` is retried as `worktreeLost` without the answer.
