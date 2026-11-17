## Why

Release 0.6.0 task 3 (ORC-114). `deploy/README.md` misstated how an origin URL becomes a run id: it said the daemon lowercases the host and drops a default port for every URL, which holds for `http` and `https` only. It also stated the older lease rule ("at least the deadline"), said the daemon exits 0 after SIGTERM even when batches are left unflushed, said `--break claimable` costs `SMOKE-PARKED` an attempt, and never said that the API takes no credential.

No test held a run id as a literal: every test compared `runIdForOrigin` with its own output, so a change to the rule, or to Node's URL serialisation, would change the run id of existing deployments without a failing test. "Run id per deployment" says origin hashes leave out user information, with no word on the scp-like address, which does not parse as a URL and keeps its user.

## What Changes

- **Frozen origin identity.** `test/runs/run-id-vectors.test.ts` holds twenty origin addresses and their run ids as string literals, plus one literal each for the repository path hash and the run's advisory lock key. `src/runs/runDir.ts` is not changed.
- **Deploy notes.** A section "Who this layout is for" before "Daemon image": the reference manifests are a single-user preview on kind; the API takes no credential except the launch token on six routes; who reaches it; the Service is not to be exposed; what the `Origin` and `Host` refusal covers; authentication comes with the hardening milestone (ORC-34). The run id, lease, SIGTERM exit code and lost-worktree sentences are corrected, and the statements that follow from tasks 1, 4, 8, 9, 19 and 20 are added.
- **The older lease rule** is corrected in `deploy/base/orchestrator.yaml`, two comments in `src/config.ts`, one in `src/main.ts`, and the ConfigMap assertion in `test/host/deploy.test.ts`, which now calls `leaseCoversFlushDeadline`.

## Capabilities

### Modified Capabilities
- `state-backend`: ADDED "Origin identity is frozen". "Run id per deployment" is not modified.
- `cluster-runtime`: ADDED "Deploy notes state who the layout is for". "Deployment run id" is not modified.

## Impact

- `test/runs/run-id-vectors.test.ts` (new), `test/host/deploy.test.ts`.
- `deploy/README.md`, `deploy/base/orchestrator.yaml` (a comment; the ConfigMap's hash suffix changes).
- `src/config.ts` and `src/main.ts`: comment lines only.
