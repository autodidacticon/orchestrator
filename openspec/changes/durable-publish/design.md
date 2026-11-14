## Context

`gateOnDurable` (journaled-store) wraps the verifier backend's `run`: it waits for durability once, on entry. The backend then records `checking`, `verified` and `publishing` and moves refs inside the same call, so the records that justify the ref update and the push were never waited for. Recovery on a fresh clone (store-selection) judged a queued job only by whether its sealed commit was in the clone.

## Decisions

- **One awaited hook, not gated progress.** `VerifierContext.durable?()` is optional, so hand-built contexts and fake backends are unchanged. It is awaited once, after `publishing` and before `updateRefCas`. Gating every progress call would make `checking` and `verified` wait for no effect.
- **Fatal is an exit, not a hang.** The journal's `durable()` never resolves after a fatal condition, and `stop()` awaits the verifier. `Orchestrator.waitDurable()` races `durable()` against a 100 ms poll of the journal's `fatalReason()` and throws `StoreFatalError`. The dispatcher treats that like `JobDroppedError`: it logs and records nothing, so the job stays `publishing` in the image and is decided at the next start. `store.ts` and `journal.ts` stay untouched, so `fatalReason` is read duck-typed.
- **Lookup in recovery, not in the backend.** The orchestrator keeps the shared `Origin`, and `recovery.ts` does the trailer lookup itself with `findTrailer` on the tracking ref. A fake verifier with pushing on gets the same answer. The lookup is a read: refs are not moved, and the verifier fast-forwards the clone when it next starts from origin.
- **Origin's commit wins.** A job found on origin is recorded with `publishedSha` set to the commit that carries the trailer, not the recorded `squashSha`.
- **Deferral is in-memory.** `Orchestrator.deferredJobs` lists jobs recovery could not decide. A restart runs recovery again, which rebuilds the list. While the list is not empty, `startVerifierIfIdle` runs `decideJobsOnOrigin` in the verifier slot, at most once a second. `stop()` and `settle()` already await that slot. Deferred jobs are skipped when the verifier picks its next job; other queued jobs still run.
- **A configuration error is not an outage.** An `OriginConfigError` from the fetch is treated as "no lookup": the verifier reports it on the job, as before.

- **ADDED, not MODIFIED.** "Startup on a fresh clone" is still an unarchived ADDED requirement of `store-selection`, and "Recovery per boundary" is MODIFIED by `origin-source-of-truth`. A MODIFIED block here would depend on which change is archived first. The ADDED requirements instead state that they take precedence over those rules, by name. Fold them in when the three changes are archived.

## Risks

- While origin is down, a deferred job waits. That is intended: no answer is better than a wrong `commitLost`.
