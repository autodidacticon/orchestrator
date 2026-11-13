## Context

The lease is the daemon's only bound on a claimed launch's silence. A spawned launch has a process: every tick that observes it alive renews the lease, so silence there is a health matter (stuck), not a lease failure. A claimed launch has no process the daemon can watch. Two things renew its lease: its own API calls, and worktree progress the tick observes. One foreground command that runs longer than `leaseTtlMs` and changes nothing in the worktree therefore loses the launch, even though the worker is alive. A test suite or an install is such a command.

## Decisions

### 1. Tell the worker, with numbers from the claim
The claim response carries `leaseTtlMs`, `leaseExpiresAt`, and `lease: { ttlMs, expiresAt, renewEveryMs }`. `renewEveryMs` is `floor(ttlMs / 3)`. A third leaves room for two missed beats before expiry. A repeated claim reads the expiry from the task's lease, which calls since the first claim have extended, rather than computing `now + ttl`.

The worker prompts use these numbers:
- In `work.js`, the claimer returns `leaseTtlMs` and `renewEveryMs` from the claim and `workerPrompt` interpolates them.
- In `work.mjs`, the preamble reads them from the claim.

The brief is composed when the launch is prepared, before any claim, so it reads the same `leaseTtlMs` from the daemon's configuration through a new optional `BriefInput.leaseTtlMs`. That is the value the claim later states. With no TTL in the input (older fixtures, direct `composeBrief` calls) the line is omitted. Every prompt says to run commands longer than the interval in the background and to heartbeat while they run.

### 2. Renew from the loop, without counting progress
The loop renews through a new route, `POST /v1/launches/:id/renew`, with `Authorization: Bearer <token>`, rather than through `heartbeat`. `heartbeat` goes through `agentCall`, which records a progress signal and so would reset the stuck clock. `renewClaim` authenticates like an agent call and refuses anything that is not a live claimed launch still holding its task. It then calls only `renewLease`: no `progressAt`, no `lastSignal`, no event. Renewals every few minutes per launch would only add noise to the event log. The route lives in `src/operator/routes.ts` beside `release` and `usage`, the other worker-loop routes.

`startRenewal` in `work.mjs`:
- sets an interval of `renewEveryMs`, unref'd, with one request in flight at a time;
- starts when the child is spawned, and stops on the child's `close` and again after the run promise settles, which covers a spawn error and a watcher kill;
- stops for good on 401 (revoked), 409 (no longer held) and 404 (an older daemon without the route);
- treats a network error as a missed beat.

With no lease facts in the claim (an older daemon) it never starts.

The Claude Code workflow has no process between agent calls, so item 1 is its only protection.

### 3. Expire gently when the worktree shows progress
`expireClaim` replaces the inline failure in `reconcile`. Progress since the claim means a commit (head is not `launch.baseSha`, the sha the worktree was prepared at) or a dirty file. Two other signals were rejected:
- The stored `fingerprint` cannot serve as a baseline, because every tick that observes a change overwrites it.
- Any API call is the release's broader test. Here it would keep a worker that only heartbeated and did nothing, and the decision was that such an expiry still spends the attempt.

`workspace.preserve` is the test as well as the action. On a clean tree at the base sha it does nothing and returns the base sha. Otherwise it commits dirty files as a WIP commit and returns the new head. So one call gives both the verdict and the preserved head, and no workspace interface changes.

`preserve` runs only when the task's `interruptions` is under `daemon.maxKeptReleases` (0 means unlimited). Past the bound the expiry fails, as before.

After the await, `expireClaim` re-checks that the lease is still expired and the launch still live. A call that arrived while git ran renewed the lease, and the launch lives on. A WIP commit made in that window stays on the worker's branch, which is harmless: the work is the worker's own, and a submit includes it.

A kept expiry follows the shape of a kept release:
- it appends `launch.released` with `reasonCode: "leaseExpired"` and `kept: true`;
- it applies `running → unstarted` (trigger `released`) with `carry.interrupted = { priorLaunchId, priorBranch, headSha, wipCommit?, reason: "leaseExpired", interruptions }`;
- it increments `interruptions`;
- it ends the launch with `endReason: "leaseExpired"` and `{ kept: true }` in the event;
- it removes the worktree and keeps the branch.

The existing "Interrupted context in the brief" text names the branch in the retry's brief. A failed expiry is unchanged: usage recorded, `fail(leaseExpired)`, launch ended, worktree removed.

## Risks

- A worker that holds a claim, commits, and then hangs forever now costs no attempt, up to `maxKeptReleases` times. The bound and the stuck detector (`stuckFailAfterMs`) still limit it.
- The renewal makes the lease meaningless while the agent process lives. What bounds a hung agent is the loop's silence limit (`--max-silence-ms`, default the daemon's `stuckFailAfterMs`) and the daemon's stuck detection. Renewal deliberately does not touch either.
- The `task-lifecycle` delta updates "Claimable launches". The transition table there still lists "lease expired" only under `running → failed`; the kept path uses the existing `running → unstarted` "released with keep after progress" row. Rewording that row is a follow-up.
