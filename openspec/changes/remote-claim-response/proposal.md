## Why

A remote worker (ORC-11) cannot use the daemon's `worktree` or `briefPath`: it works in its own clone on another machine. To start, it needs the URL to clone, the integration branch, the base commit and the brief itself (ORC-16, cloud-native M3). ORC-22's worker loop consumes this response.

## What Changes

- A claim of a launch with `access: remote` answers every field of the local response except `worktree` and `briefPath`, plus `access: "remote"`, `repoUrl`, `integrationBranch` and `briefMarkdown`. `brief` is the stored `briefJson`; `briefMarkdown` the stored text. Neither is read from disk.
- New config-file key `git.workerOriginUrl` (optional, non-empty, read at start). `repoUrl` is `git.workerOriginUrl`, else `git.originUrl`, else the URL of the clone's `origin` remote, as written. `git.originUrl` keeps its meaning (the daemon clone's origin, hashed for the run id under Postgres).
- `carry` is included when the stored brief's context holds `interrupted`, so the worker starts its branch at `carry.interrupted.headSha`. It comes from the stored brief, so a repeated claim (`repeated: true`) answers the same.
- A remote claim records no baseline fingerprint and does not call `Workspace.fingerprint`.
- The local claim response is unchanged.

## Capabilities

### Modified Capabilities

- `pull-runner`: "Claim" gains the remote response and five scenarios.

## Impact

- `src/config.ts` (`git.workerOriginUrl`), `src/loop/orchestrator.ts` (`claim`, `claimResponse`, `remoteClaimResponse`, `workerRepoUrl`).
- Tests: `test/loop/remote-claim.test.ts`, `test/slice/remote-claim.test.ts`.
