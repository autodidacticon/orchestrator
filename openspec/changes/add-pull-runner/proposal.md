## Why

The daemon only pushes work: every launch is a headless process it spawns. A user already inside a Claude Code session may want the session's own subagents to execute launches, such as a Workflow fan-out or an `ultracode` session: visible in the session, running with its permissions and login. That needs a pull model where workers claim launches the daemon has prepared. A planning conversation on 2026-10-12 (`plans/5-pull-runner/plan.md`) settled the shape: local workers now, with the claim API shaped so that a worker on another machine can be added later. This change builds on `add-health-monitoring`, whose progress signals (worktree fingerprint, API calls) decide whether a released claim counts as an attempt and keep a claimed launch's lease alive.

## What Changes

- Add runner modes. `runner.mode` is `spawn` (the status quo and the default), `pull` (prepared launches wait to be claimed and nothing is spawned), or `mixed` (a launch is parked for `runner.claimWindowMs`, default 60 s, then spawned if nobody claimed it). `start` can set the mode for a run.
- Add a `claimable` launch state between preparation and live. The daemon creates the worktree, writes the brief, and generates the token as today, then parks the launch. A parked launch holds a capacity slot, so the number of parked launches is bounded by `capacity`.
- Add claim and release. `POST /v1/claims` hands the oldest claimable launch, or a named task's, to a worker and makes it live with a worker id and no pid; its lease starts at the claim. `POST /v1/launches/:id/release` hands it back: without progress the task returns to `unstarted` at no cost, with progress it is a failed attempt. Claims are idempotent per worker id. `access: 'local'` is the only accepted mode; `access: 'remote'` is reserved and answered 501.
- Report workers. `status` gains `claimable`, `workers`, and the runner mode; the event digest gains a `claimable` count.
- Add worker tools to the operator MCP server: `claim`, `release`, and token-scoped `launch_heartbeat`, `launch_report`, `launch_block`, `launch_inbox`, and `launch_log`, so a session subagent that cannot run the per-agent MCP shim can act as the agent. `launch_block` stays a foreground call bounded at ninety seconds.
- Ship a `work` skill and a bundled Workflow script that fans out N workers, and a marketplace manifest at the repository root with a test that pins the plugin version to the package version.
- Extend crash safety: a claim boundary whose durable record precedes the response, crash points `launch.afterClaimable` and `claim.afterRecord`, and recovery rules for claimable and claimed launches.

## Capabilities

### New Capabilities
- `pull-runner`: runner modes and the claim window, claim and release semantics, worker identity and idempotent re-claim, access modes, and the reserved remote mode.

### Modified Capabilities
- `task-lifecycle`: the transition table gains `running -> unstarted` for a claimed launch released without progress; a new requirement covers claimable launches: the slot they hold, the lease that starts at the claim, counters, and the expiry path.
- `agent-protocol`: workers act through the token-scoped operator tools under the same scoping, deduplication, sealing, and fencing rules; the fallback file is not available to them.
- `operator-control`: routes for claims, releases, and the mode override, each recorded as an event; status and digest additions for workers; a reaping shutdown leaves claimed launches to their leases.
- `operator-mcp`: the worker tools and the `mode` argument on `start`.
- `host-integration`: the work skill and workflow script, and the marketplace manifest with the version check.
- `crash-recovery`: the `claimable` state, the claim boundary, the two crash points, and recovery of claimable and claimed launches.

## Impact

- `src/config.ts` gains a `runner` block. `src/launch/launch.ts` splits preparation from spawn. `src/loop/tick.ts` spawns parked launches whose window elapsed and reconciles claimed launches by lease rather than by pid. `src/launch/recovery.ts` learns the new states. `src/loop/orchestrator.ts` gains `claim` and `release`; `src/operator/routes.ts` gains three routes; `src/operator/mcp-server.ts` gains seven tools; `src/state/transitions.ts` gains one row and `src/state/status.ts` a `released` failure kind.
- New host files `hosts/claude-code/skills/work/SKILL.md` and `hosts/claude-code/workflows/work.js`, and `.claude-plugin/marketplace.json` at the repository root. Marketplace copies still need the executables on PATH, as before.
- Launch rows gain a status value and a `worker` field inside the existing JSON document; no table migration. Spawn mode behaves exactly as before, so existing runs, configurations, and the crash suite are unaffected.
- The crash suite gains a pull-mode matrix driven by scripted workers. Remote workers are not implemented; the request shape reserves them.
