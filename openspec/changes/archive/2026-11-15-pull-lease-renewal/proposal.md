## Why

In run a96781f5ed84268e (2026-11-13), ORC-15's first pull-mode launch lost its lease. The task was claimed by a Claude Code session subagent, which heartbeated once, committed, and then ran the check command (`npm ci && npm run build && npx vitest run`, several minutes with the Postgres suites) in the foreground. An agent cannot call a tool while a foreground command runs, and a claimed launch has no process the daemon can watch, so nothing renewed the 10-minute lease. The daemon failed the attempt with `leaseExpired` and discarded about 20 minutes of work. The worker prompt said only "heartbeat after long steps": it gave no interval and did not mention the lease. Spawn mode is unaffected, because liveness renews the lease, and remote worker pods (ORC-26) have the same exposure as pull mode.

## What Changes

- **The claim states the lease.** The claim response carries `leaseTtlMs`, `leaseExpiresAt`, and `lease: { ttlMs, expiresAt, renewEveryMs }`, where `renewEveryMs` is a third of the TTL. A repeated claim states the current expiry.
- **The worker prompts and the brief state the interval.** The brief's Reporting section gains a lease line (`leaseTtlMs` is also written to `brief.json`). The worker prompts of the Claude Code workflow (`hosts/claude-code/workflows/work.js`) and of the work loop (`hosts/codex/bin/work.mjs`) also gain an interval rule. All three tell the worker to call at least every `renewEveryMs` and to run any longer command in the background, heartbeating while it runs. The prompts take the numbers from the claim. The brief takes them from the same `leaseTtlMs`.
- **The work loop renews the lease.** A new `POST /v1/launches/:id/renew` route, authenticated with the launch token, renews a claimed launch's lease. It is not a progress signal: it leaves `progressAt`, `lastSignal` and the stuck clock alone, and appends no event. `orchestrator-work` calls it every `renewEveryMs` while the agent process lives. It stops when the process exits, and for good on 401, 404 or 409.
- **Expiry with progress is kept.** When a claimed launch's lease expires, the daemon checks the worktree for progress since the claim: a commit on the branch (head is not the base sha) or a dirty file. With progress, and with the task's kept releases under `daemon.maxKeptReleases`, the expiry ends as a kept release. Uncommitted work is committed on the branch, the branch is kept, `attempts` is unchanged, and the next brief carries `interrupted` naming the branch. Without progress, or past the bound, it stays a failed attempt with reason `leaseExpired`.

## Capabilities

### Modified Capabilities
- `pull-runner`: the lease facts in the claim; renewal by the work loop; lease expiry with progress as a kept release ("Release" no longer sends every expiry down the failure path).
- `host-integration`: the work workflow's interval rule; the work loop's renewal timer and its preamble's interval rule.
- `agent-protocol`: the brief's heartbeat interval.
- `task-lifecycle`: "Claimable launches" names the loop's renewal among the renewers and the kept expiry beside the failure path.
- `host-integration` (also modified): the hung-agent scenarios name `stuck`, not lease expiry, as the daemon's verdict on a silent agent whose loop renews.

## Impact

- Code:
  - `src/loop/orchestrator.ts`: `leaseFacts`, `renewClaim` and `expireClaim`, the claim response, and `leaseTtlMs` in the brief input.
  - `src/loop/tick.ts`: a claimed launch's expiry calls `expireClaim`.
  - `src/operator/routes.ts`: the renew route.
  - `src/operator/mcp-server.ts`: the `claim` and `launch_heartbeat` descriptions.
  - `src/brief/compose.ts`: `leaseRule`, `renewEveryMsOf`, and `leaseTtlMs` in `brief.json`.
  - `src/workspace/workspace.ts`: the optional `BriefInput.leaseTtlMs`.
  - `hosts/codex/bin/work.mjs`: `renewEveryMs`, `startRenewal`, and the preamble line.
  - `hosts/claude-code/workflows/work.js`: lease fields in the claimer's output, and the worker prompt rule.
- Tests:
  - `test/loop/lease.test.ts` (new).
  - `test/host/work-loop.test.ts`: the silent-agent test, the gone-loop test, and renewal unit tests.
  - The brief fixtures under `test/fixtures/brief/` are unchanged, because their inputs carry no `leaseTtlMs`.
- No configuration change. `leaseTtlMs` keeps its 10-minute default.
