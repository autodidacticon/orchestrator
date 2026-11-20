## Why

Under `verifier.mode: remote` (#32) the daemon no longer checks a verify job itself: it offers each job over its API (#30), waits for a verifier to claim it and post a result, and publishes from the ref the verifier pushed. Nothing claims such a job yet, so on a remote-verification run every task would stay `submitted`. This change adds the verifier loop (GH-33) that claims and works those jobs.

## What Changes

- New bin `orchestrator-verifier` (`dist/src/verifier/loop.js`, from `src/verifier/loop.ts`). It claims one verify job at a time with `POST /v1/verify/claims` and `{ verifierId }`, waits with backoff when nothing is offered, and exits on the idle limit, the job limit, or SIGTERM and SIGINT.
- `src/verifier/job.ts`: one job's steps. Clone (`ensureClone`), fetch, a detached worktree at the expected head under `<cache>/verify/<jobId>`, the daemon's `rebaseSealed`, the daemon's `runCheck` unchanged, `git push --force origin <rebasedSha>:refs/verify/<jobId>` (three tries), and one of six outcomes. Remote commands run under `LC_ALL=C` with a fixed 120000 ms limit.
- `src/verifier/heartbeat.ts`: the job lease heartbeat with the job token; a 401 aborts the job.
- The result post and its answers; a release with `verifierError` after an error of the loop, and with `podTerminating` on termination.
- Variables: `ORCH_API`, `POD_NAME`, `ORCH_VERIFIER_ID`, `ORCH_VERIFIER_CACHE`, `ORCH_VERIFIER_IDLE_EXIT_MS`, `ORCH_VERIFIER_MAX_JOBS`, `ORCH_VERIFIER_BACKOFF_MS`, `ORCH_VERIFIER_BACKOFF_MAX_MS`, `ORCH_RETRY_WINDOW_MS`.
- README names the bin and describes the loop.

Nothing outside `src/verifier/` changes. No image or manifest is built here: #35 links the bin into the image and adds the Deployment.

## Capabilities

### New Capabilities
- `verifier-pool`: the verifier loop, its job steps, heartbeat, result post, check environment and termination: the ADDED requirements `Verifier loop`, `Verifier job steps`, `Verifier heartbeat`, `Verifier result post`, `Verifier check environment` and `Verifier termination`, with their `<base>: <behavior>` parts.

### Modified Capabilities
None. No requirement is modified, and worker-pool, integration-pipeline, state-backend and host-integration keep their text.

## Impact

- Code: new `src/verifier/loop.ts`, `src/verifier/job.ts`, `src/verifier/heartbeat.ts`; `package.json` (bin); `README.md`.
- Tests: `test/verifier/loop.test.ts`, `test/verifier/job.test.ts`, `test/slice/verifier-loop.test.ts`; `test/host/package.test.ts` counts seven executables.
- Follow-ups: #35 (image and Deployment), #34 (verifier token, M6), #36 (check environment allowlist, M6).
