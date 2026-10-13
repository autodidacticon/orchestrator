# Pull runner: plan for change `add-pull-runner`

## Context

The daemon (`plans/0-orchestrator-v1/plan.md`) pushes work: it spawns a headless process per
launch, and the process reports through a loopback API with a per-launch token. A session that
operates a run through the plugin (`plans/1-session-operator/plan.md`) may also want to execute
it with its own subagents, visibly and under its own permissions and login: a Workflow fan-out,
or an `ultracode` session. That needs a pull model where workers claim launches the daemon has
prepared. A planning conversation on 2026-10-12 settled the design: local workers now, with the
claim API shaped so that a worker on another machine can be added later. This document records
the decisions and their reasoning; the OpenSpec change `add-pull-runner` holds the requirements,
design record, and task checklist.

The change builds on `add-health-monitoring` (`plans/3-health/plan.md`): its progress signals,
the worktree fingerprint and API calls, decide whether a released claim counts as an attempt and
keep a claimed launch's lease alive. Its renewal for launches whose process the daemon can see
does not apply to claimed launches, which have no process. Apply this change after health
monitoring and graph mutation and before scheduling policy, in the README's order.

## Decisions

1. **Local pull now, remote later.** Workers run on the daemon's machine, reach the loopback
   API, and use the worktree the daemon prepared. The claim request carries `access: 'local'`;
   `access: 'remote'` is reserved and answered 501, so the request shape survives the later
   change. Rejected: remote now, or both at once; either puts a second workspace model and a
   second trust model into the first pull runner before the first has been used.
2. **The daemon prepares; the worker reports through the API.** The launch lifecycle gains a
   `claimable` state between preparation and live: worktree, brief, and token as today, then
   the launch is parked. Sealing on submit, sweeps, verification, and 401 fencing are unchanged
   because the worktree is still the daemon's. Rejected: worker-owned workspaces, which cost
   sealing and sweeping their footing locally and are the right model only for remote.
3. **Three modes.** `runner.mode` is `spawn` (default), `pull`, or `mixed`. Every parked launch
   has a claim window: zero in spawn, `runner.claimWindowMs` (default 60 s) in mixed, unbounded
   in pull; the tick spawns a parked launch whose window has elapsed. `start` can set the mode
   for a run; the override is durable and applies from the next tick, to parked launches too.
   Rejected: spawn or pull only. A session wants headless agents to pick up what its workers
   leave, and `mixed` is what makes a mode switch safe.
4. **Claimable is a launch state; the task is running and holds the slot.** Capacity counts
   claimable and live launches alike, so parked launches are bounded by `capacity`. The lease
   of a parked launch does not run; it starts at the claim with `leaseTtlMs`, renewed by any API
   call, by observed worktree progress, and at admission after a resume. Rejected: a new node
   state (admission, readiness, reload classification, and the reopen guard would all change)
   and keeping the task unstarted while parked (the scheduler could admit it twice).
5. **Claim and release semantics.** A claim takes the oldest claimable launch or the named
   task's (404 when none, 409 when not claimable), records the worker and the lease in one
   transaction, and returns the launch id, token, worktree, brief, base sha, and API URL. It is
   idempotent per worker id, and a re-claim carries the open question and any admitted answer.
   Release without progress returns the task to `unstarted` through a new transition row and
   consumes no attempt; after progress it is a failed attempt with reason `released`; while
   waiting it acts as process death. Rejected for the no-progress case: a same-attempt relaunch
   with the task still running, which would misreport a handed-back task and bypass pause.
6. **Worker tools on the operator MCP server.** `claim`, `release`, and token-scoped
   `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`
   forward to the agent API with the bearer token, because a session subagent cannot run the
   per-agent shim and cannot add MCP servers. `launch_block` is bounded at ninety seconds like
   `wait`: `{ answer }` or `{ pending: true }`, then the worker calls again with the same seq,
   which the daemon's replay rules serve. Workers have no fallback file: no process death
   triggers recovery for them; lease expiry converges instead.
7. **Work skill plus a workflow script.** The skill: `start` with mode pull or mixed, a worker
   count no larger than capacity, a run tag, the bundled workflow, questions answered through
   the user and the workflow re-run with the same tag, review when due, stop on finished or
   stalled with nothing claimable. `work.js` keeps control flow in the script: N loops in
   `parallel`, each cycle a cheap claimer agent and, when a launch comes back, a worker agent
   whose prompt is composed from the brief plus tool instructions; a loop ends when nothing is
   claimable, no loop holds a launch, and the digest says finished, stalled, or question open.
   Scripts cannot call tools or read the clock, so worker ids come from `args`. Rejected: one
   long-lived worker agent per loop, whose context would carry every previous brief.
8. **Marketplace manifest.** `.claude-plugin/marketplace.json` at the repository root lists the
   `orchestrator` plugin with `source: "./hosts/claude-code"`, and a test asserts the plugin
   version equals the package version. Rejected: a separate marketplace repository. Marketplace
   copies still need the executables on PATH.
9. **Crash safety.** The claim is a new boundary: the response is the external effect, the
   durable record is the launch row update in one transaction before responding, and a lost
   response is covered by the idempotent re-claim. Crash points `launch.afterClaimable` and
   `claim.afterRecord`. Recovery keeps claimable launches claimable (worktree verified,
   re-prepared when missing) and keeps claimed launches while their lease is unexpired. The
   crash matrix runs a second time in pull mode with scripted workers.

## Implementation

Five task groups in `openspec/changes/add-pull-runner/tasks.md`:

1. Modes and claimable launches (`runner` config and the durable override, launch and store
   types, `prepareLaunch` and `spawnLaunch`, the claim window in the tick, reconcile by lease).
2. Claim and release (the transition row and failure kind, `claim` and `release` on the
   orchestrator, routes and events, status and digest fields, CLI commands).
3. Recovery and the crash suite (recovery of claimable and claimed launches, the sweep, a
   scripted worker, the pull-mode crash matrix).
4. Operator MCP worker tools (seven tools, the bounded `launch_block`, `start` with `mode`).
5. Host: work skill, workflow, marketplace (SKILL.md, `work.js`, the manifest, README, host
   tests, a scripted mixed-mode end to end, the opt-in end to end).

Gate: group 3's pull-mode crash matrix plus group 4's stdio worker test. Spawn mode is untouched,
so the existing crash suite keeps running unchanged as the regression check.

## Verification

- `npm test` green including every existing suite and the crash matrix in both modes;
  `claude plugin validate --strict hosts/claude-code` passes with the work skill and workflow;
  the marketplace manifest parses; plugin and package versions match.
- Route tests: claim ordering, named-task claim, 404 and 409, 501 for remote, idempotent
  re-claim, release with and without progress. Mode tests: pull parks and never spawns, mixed
  spawns after the window, spawn unchanged, capacity counts claimable launches.
- Over a real stdio client, the harness acts as a worker through the token-scoped tools:
  claim, commit in the worktree, block and answer, report, verification publishes with trailers.
  An abandoned claim expires into a failed attempt and a re-prepared launch.
- Opt-in: `ORCH_E2E_CLAUDE_WORK=1` runs a real Claude Code session with `--plugin-dir` using
  the work skill with two workers on a three-task graph; every task ends done and the
  integration branch carries one trailer commit per task.
- Sync hazard: `add-graph-mutation` also replaces `Transition table enforcement` in
  task-lifecycle. Whichever change archives second must first fold the other's rows into
  its block, because the sync replaces the requirement wholesale.

## Deferred

- Remote workers: a shared git remote as the integration point, the daemon pushing the
  integration branch after each publish with force-with-lease and fetching the worker's branch
  on submit, a network-bound API with worker tokens, and a network path the user provides, for
  example Tailscale. The claim API already reserves `access: 'remote'`.
- Rebasing a parked launch when the integration head moves before it is claimed.
- A monitor for the work skill so questions surface without re-running the workflow.
- Worker affinity and per-task mode selection, with scheduling policy
  (`plans/6-scheduling/plan.md`).
