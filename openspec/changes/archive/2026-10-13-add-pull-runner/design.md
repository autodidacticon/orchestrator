## Context

The daemon pushes work: `startLaunch` writes a row, prepares a worktree with a brief, spawns a detached process, and records its pid. Agents report through a loopback API with a per-launch bearer token, and the crash suite proves convergence around every boundary. A Claude Code session that operates a run through the plugin (`add-session-operator`) may also want to execute it: a Workflow fan-out or an `ultracode` session can run subagents that do the work visibly, with the session's permissions and login. Those subagents inherit the session's MCP servers, cannot add their own, and are moved to the background if a tool call runs longer than two minutes. `add-health-monitoring` gives the daemon progress signals (worktree fingerprint, API calls) and lease renewal for launches whose process it can see. This change relies on those signals for claimed launches, which have no process at all.

## Goals / Non-Goals

**Goals:**
- Let workers on the same machine claim launches the daemon prepared, do the work in the daemon's worktree, and report through the existing API.
- Keep spawn mode exactly as it is, and let one run mix both.
- Keep every invariant: sole writer, sealing on submit, 401 fencing, sweeps, one trailer commit per task, convergence after a crash at any point.
- Give a Claude Code session a skill and a bundled workflow that make this a one-call operation.

**Non-Goals:**
- Remote workers on another machine. The claim request reserves `access: 'remote'`; the deferred section of the plan records what it would need.
- Worker-owned workspaces, per-task mode selection, or scheduling changes (`add-scheduling-policy`).
- Replacing the per-agent MCP shim for spawned agents.

## Decisions

**Local pull now, remote later.** Workers reach the loopback API and use the daemon's worktree. `access: 'local'` is the only accepted value and `access: 'remote'` is answered 501, so the request shape does not change later. Remote would need a shared git remote as the integration point, the daemon pushing the integration branch after each publish with force-with-lease and fetching the worker's branch on submit, a network-bound API with worker tokens, and a network path the user provides, for example Tailscale. Doing remote now, or both at once, would put a second workspace model and a second trust model into the first pull runner before the first has been used.

**The daemon prepares, the worker reports.** A pull launch goes through the same preparation as a spawned one: row, worktree at `baseSha`, brief, token. It then parks as `claimable` instead of spawning. Sealing on submit, sweeps, verification, and fencing keep their footing because the worktree is still the daemon's. Worker-owned workspaces were rejected for local use: sealing would have to trust a path the worker chose, and sweeps could not tell a stray worktree from a worker's. They are the right model for remote, which is one more reason remote is deferred rather than squeezed in.

**Three modes, one mechanism.** Every parked launch has a claim window: zero in `spawn`, `runner.claimWindowMs` in `mixed`, unbounded in `pull`. The tick spawns any parked launch whose window has elapsed, so a mode switch (through `start` with `mode`, stored durably and applied from the next tick) only changes the window applied to launches already parked. Spawn-or-pull-only was rejected because a session wants headless agents to pick up what its workers leave, and because `mixed` is what makes a mode switch safe.

**`claimable` is a launch state, not a node state.** The task is `running` from the moment its launch row exists, as today, so capacity and the lease rules apply unchanged and parked launches are bounded by `capacity`. Status lists parked tasks under `claimable` so the operator can tell them apart. A new node state would have touched admission, readiness, reload classification, and the reopen guard for no gain. Keeping the task `unstarted` while parked would have let the scheduler admit it twice.

**Release without progress returns the task to `unstarted`.** This is a new transition row, `running -> unstarted` by the orchestrator, consuming no attempt; the worktree is removed and the next admission prepares a fresh launch. The alternative, ending the launch and starting a same-attempt relaunch while the task stays `running` (what recovery does for an unknown spawn), would have reported a handed-back task as running and let it bypass pause. Release after progress is an attempt: the existing `running -> failed` row with a `released` reason, so the next brief carries the worker's reason. Release while `waiting` acts as process death: `blocked` with the question preserved. Progress is what `add-health-monitoring` measures: a commit or dirty file in the worktree, or any API call under the token after the claim.

**Claims are idempotent per worker id and carry the open question.** The durable record is one transaction (launch row to `live` with the worker id, lease reset to `leaseTtlMs` from now, event) committed before the response, so a lost response is repaired by claiming again with the same worker id, which returns the same launch and token. A re-claim also returns the launch's open question seq and any admitted answer, so a fresh worker can collect the answer with `launch_block` and the same seq. Claim tickets or a separate resume call would have added state the worker id already provides. One live launch per worker id keeps `workers` in status honest.

**Token-scoped worker tools on the operator server.** A session subagent cannot run the per-agent shim, so the operator server forwards `launch_*` calls to the agent API with the bearer token from the call. `launch_block` is bounded at ninety seconds like `wait`: the server returns the daemon's answer when it arrives in time and `{ pending: true }` otherwise; the worker calls again with the same seq, and the daemon's replay rules (re-attach while waiting, dedup once answered) do the rest. Workers have no fallback file: recovery applies the file only when it finds a process dead, and a claimed launch has none. A worker that cannot reach the API retries until the lease expires, and the expiry path already converges.

**Control flow in the workflow script, judgment in agents.** `hosts/claude-code/workflows/work.js` fans out N worker loops with `parallel`. Each cycle is a cheap claimer agent (claims with the loop's worker id, or waits briefly and reports the digest) and, when a launch comes back, a worker agent whose prompt is composed from the brief plus tool instructions. A worker agent that dies is repaired by the next idempotent claim. A loop ends when nothing is claimable, no loop holds a launch, and the digest says finished, stalled, or that a question is open; the `work` skill then answers questions through the user and re-runs the workflow with the same run tag so workers get their launches back. Scripts cannot call tools or read the clock, which rules out the script claiming for itself, so worker ids come from `args`. One long-lived worker agent per loop was rejected: its context would carry every previous task's brief.

**Marketplace manifest at the repository root.** `.claude-plugin/marketplace.json` lists the `orchestrator` plugin with `source: "./hosts/claude-code"`, so `claude plugin marketplace add <owner>/orchestrator` installs from the same repository. A test pins the plugin version to the package version so a release cannot drift. A separate marketplace repository would be a second thing to release.

## Risks / Trade-offs

- [A worker vanishes mid-task] → the lease expires after `leaseTtlMs` without API calls or worktree progress; the attempt fails and a new launch is prepared, as for a dead process.
- [Parked launches hold capacity that spawned agents could use in `mixed`] → the claim window bounds the wait, and `capacity` bounds the parked count.
- [Questions during a workflow run have nobody to answer them] → the worker loop ends when a question is open and nothing else is claimable; the skill answers through the user and re-runs with the same run tag, and the re-claim carries the answer.
- [Other pending changes modify the transition table or extend the tool set] → the table row is one line, re-checked against the archived deltas at sync; the `Tool set` count is reconciled there.
- [Marketplace copies have no executables] → unchanged from `add-session-operator`: the install step is `npm link` or a global install, stated in the skill and the README.
- [A claimed launch resumed from `waiting` has a stale lease] → the lease is renewed at admission for claimed launches; spawned ones get this from health monitoring's process-visibility renewal.
- [A `pull` run with no workers looks idle forever] → `status` and the digest report `claimable`, and the work skill stops with that count when nothing is being worked.

## Migration Plan

No data migration: the launch document gains fields and a status value inside the existing JSON column. `runner.mode` defaults to `spawn`, so existing configurations, runs, and the crash suite behave as before. The plugin gains a skill and a workflow; sessions that never call the work skill see no change.

## Open Questions

- Remote workers: whether the daemon should push the integration branch to the shared remote on every publish, or only while a remote claim exists.
- Whether a parked launch should be re-based when the integration head moves before it is claimed, or left at its `baseSha` as spawned launches are.
- Whether `pull` mode should warn at `start` when no worker has claimed within a claim window, so a forgotten run does not sit silently.
- Whether the work skill should offer a monitor so questions surface without re-running the workflow.
