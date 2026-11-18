## Why

A remote worker (ORC-11) works in its own clone, so the daemon cannot preserve or inspect its tree on release or lease expiry. Before this change, a remote release fingerprinted a constant, could never keep work (`preserve` refused), and a remote lease expiry tried to preserve and remove a worktree that does not exist. A remote worker that hands its launch back must be able to keep the work it pushed (ORC-23, cloud-native M3).

## What Changes

- `POST /v1/launches/:id/release` takes `headSha` and `wipCommit` (full hex object names; malformed: 400 naming the field). A local release ignores both. The operator MCP `release` tool and `orchestrator-ctl release` (`--head-sha`, `--wip-commit`) pass them through.
- A remote release: progress is any agent API call since the claim, or a `headSha` other than the base. With `keep` and progress under `daemon.maxKeptReleases`, the daemon fetches the launch branch through origin (the remote seal of ORC-18) and requires its tip to equal `headSha`: otherwise 409 `branchNotPushed` / `shaMismatch`, or 503 `originUnreachable` / `originRefused`, and the launch stays live with nothing recorded. A kept remote release stores `carry.interrupted` as a local one does. A keep without `headSha` is released without keep, with `keepError` naming `headSha`. No `fingerprint`, `preserve` or `remove` is called.
- A remote lease expiry reads the branch tip at origin with `ls-remote` (new `Origin.branchTip`). A tip other than the base is a kept release at that tip (reason `leaseExpired`, `launch.released` carries `headSha`); no branch or the base fails the attempt with `leaseExpired`. The tick never waits for the read beyond its short bound (none while origin is busy); startup recovery awaits it. Origin unreadable or the read still running: the expiry is skipped and tried on later ticks until the lease's expiry time plus one TTL (twice the TTL since the last renewal), then the attempt fails. No preserve, no removal.
- Local release and lease expiry are unchanged.

## Capabilities

### New Capabilities

None. `remote-workspace` is introduced by the unarchived change `remote-access-mode`; this change adds a requirement to it.

### Modified Capabilities

- `pull-runner`: "Release", "Lease expiry" and "Kept expiry record" cover remote launches.
- `remote-workspace`: new requirement "Remote launch end".

## Impact

- `src/loop/orchestrator.ts` (`release` dispatches to `releaseRemote`; `expireClaim` to `expireRemoteClaim`), `src/workspace/origin.ts` (`branchTip`, `branchTipFromTick`, `forgetBranchTip`), `src/launch/recovery.ts` (awaits origin at startup), `src/agent/seal.ts` (`optionalFullSha`), `src/operator/routes.ts`, `src/operator/mcp-server.ts`, `src/operator/cli.ts`.
- Tests: `test/slice/remote-release.test.ts`; `test/loop/remote-claim.test.ts` checks its fingerprint wrapper through a tick instead of a release, since a remote release no longer fingerprints.
