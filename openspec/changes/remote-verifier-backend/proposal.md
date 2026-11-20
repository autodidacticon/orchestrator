## Why

The daemon runs every check itself: `GitVerifierBackend.run` rebases the sealed commit in a temporary worktree under `<dataDir>/verify` and runs the check command in the daemon's environment. In a cluster that puts repository code and its toolchain in the daemon pod. #30 added the routes through which a verifier claims a verify job and posts its result, and #33 adds the verifier loop, but nothing offers a job to them. This change (GH-32) adds the backend that does.

## What Changes

- New file key `verifier.mode`: `local` (default, today's in-process backend) or `remote`. Any other value fails with `verifier.mode must be one of local, remote`. `remote` needs `runner.access: remote`; `remoteVerifierError` refuses it before the API listens and in `Orchestrator.start()` before the graph is loaded.
- New `RemoteVerifierBackend` (`src/verify/remote.ts`), extending `GitVerifierBackend`. It syncs with origin as today, offers the job (`checking` with `expectedHead` and an `offer` holding the check command) and waits for the stored result through the new `VerifierContext.awaitResult`. A `verified` result is checked against `refs/verify/<jobId>` on origin, squashed and published as today, and the ref is deleted. The daemon creates no worktree and runs neither the check nor the prepare command.
- Every job write that sets `queued`, `published`, `failed` or `conflict` removes `offer`, `verifier`, `token` and `result`.
- Recovery under `remote` keeps an offered job that holds a result or a live verifier lease; the single verifier slot resumes it first. `stop()` ends a wait at once and records nothing.
- Under `remote` a cancel of a `submitted` task also drops its offered job that holds no result, and its wait ends at once.
- One job is still checked at a time.

## Capabilities

### New Capabilities
- `verifier-pool`: the verifier mode, the remote verification run, its outcomes, the verify ref, restarts, and which integration steps a verifier carries out.

### Modified Capabilities
- `crash-recovery`: "Recovery of verifier jobs before publishing" (claim fields removed on requeue; the kept offered job is an ADDED requirement).
- `operator-control`: "Container mode" (the stop does not wait for a job that waits for a verifier).
- `task-lifecycle`: ADDED "Cancellation: offered verify jobs". "Cancellation" keeps its text.

integration-pipeline keeps its text, including "Verifier serialization and job states".

## Impact

- Code: new `src/verify/remote.ts`; `src/verify/job.ts` (`awaitResult?`, `VerifierStoppedError`, `NO_CLAIM`); `src/config.ts` (`verifier` block, `remoteVerifierError`); `src/loop/orchestrator.ts` (`awaitResult`, resume in the slot, field removal, start refusal, wake in `stop()` and `cancel()`); `src/launch/recovery.ts`; `src/main.ts`.
- Tests: `test/slice/remote-verifier.test.ts`, `test/loop/verifier-mode.test.ts`.
- Docs: README "Verifier mode." paragraph and the "Child processes" paragraph.
