# Orchestrator for parallel coding agents over a task DAG: v1 implementation plan

## Context

Objective: reliable parallel execution of a task DAG in one repository. Agents receive
complete briefs, dependencies control admission, humans resolve blockers, and tasks become
done only after verified integration. Tracker connections and sophisticated scheduling are
later additions. The repo `/Users/richard/git/orchestrator` is empty.

The design was settled in a plan-mode conversation on 2026-10-12 across nine topics, then
revised the same day after a review that reproduced three defects (duplicate agents after
a daemon crash, an empty-diff submission passing, and a false stall report). The responses
to each finding are in the last section. Five topics are decided and form the spec below.
Four are deferred with interfaces reserved.

The first deliverable is the planning record inside the repo: an OpenSpec change holding
the requirements, design, and task checklist; this plan saved under
`plans/0-orchestrator-v1/`; and a README that indexes both. Code starts after that.

Core commitments, in one list:
- DAG with a derived ready frontier. Immutable graph plus a status overlay. No pruning.
- Ready is not assignable. Admission, capacity, and conflicts are separate concerns.
- Agents submit; a verifier promotes to done after sealed, rebased, checked, and
  atomically published integration. Done means integrated, not correct.
- Failure, blocked, stalled, and waiting are first-class. Assignment is a lease on a
  launch, and launches are distinct from attempts.
- Agents are live peers over a local HTTP API with an MCP façade. Batch (report file on
  exit) is the fallback of every live path.
- Every external effect sits between two durable records, and recovery is defined per
  boundary. A hard kill of the daemon at any instant converges to the same outcome.
- Static TypeScript with named LLM hook points. The first hook is brief remediation,
  defaulting to human review.

## Design (the spec)

### Graph model

Vocabulary: `deps(n)`, `dependents(n)`, `closure(n)`. No "root", "leaf", or unqualified
"edge". Only blocking relations are deps. Containment is a milestone node. Ids are stable
upstream ids.

```
Node     { id, kind: task|milestone, gated?: bool, deps: Set<Id>, payload: opaque }
Graph    { rev: ContentHash, nodes: Map<Id, Node> }        # immutable per load
Status   = unstarted | running | waiting(question, answer?) | submitted | done
         | failed(reason) | blocked(reason) | cancelled(reason, releasesDependents)
Entry    { status, attempts, integrationRetries, launches, lease?, updatedAt }
Overlay  = Map<Id, Entry>

satisfied(d)      = S[d]==done or (S[d] is cancelled and S[d].releasesDependents)
depsSatisfied(n)  = all(satisfied(d) for d in deps(n))
ready(G,S)        = { n in tasks      : S[n]==unstarted and depsSatisfied(n) }
milestonesDue     = { m in milestones : S[m]==unstarted and depsSatisfied(m) }
incomplete(G,S)   = { n : S[n] not in {done, cancelled} }
awaitingReview    = { n : S[n]==submitted }
openQuestions     = { n : S[n]==waiting and answer absent }
                  ∪ { n : S[n]==blocked and reason.kind in {needsDecision, needsAccess} }
finished          = incomplete == {}
stalled           = ready=={} and live=={} and awaitingReview=={} and incomplete!={}
stallRoots        = { n in incomplete : S[n] in {failed, blocked}
                      or any(S[d] is cancelled and not S[d].releasesDependents
                             for d in deps(n)) }
started(n)        = S[n] in {running, waiting, submitted, done}
revocable(n)      = S[n] in {done, cancelled}
                    and all(not started(d) for d in dependents(n))
```

Validation on load rejects: cycle (report the path), self-loop, duplicate id, dep on an
unknown id. Multiple sinks are fine.

Milestones auto-complete unless `gated`. Completion iterates to a fixed point within one
tick, so chained automatic milestones all complete in the tick that satisfies the first.
A gated milestone goes to submitted with `reviewVersion` incremented and the integration
head pinned as `integrationSha`; the head is tagged `milestone/<id>/v<reviewVersion>`.

Graph revision and reload. Each snapshot has `rev`. Every launch records the rev its brief
was composed from. On reload, the diff is classified:
- Compatible: add a node; remove a node that is not started (overlay kept as an orphan,
  never scheduled); change deps, payload, kind, or gated of a node that is not started.
- Incompatible: remove or change deps or kind of a started node; anything that fails
  validation.
An incompatible reload is rejected whole. The previous snapshot stays active and status
reports `graphRejected` with the reasons. To remove a started node, cancel it first.

Quiescence and the stall property. `quiescent(G, S, live)` holds when every running or
waiting entry has a live process and an unexpired lease, no verifier result is
unapplied, and `milestonesDue == {}`. Property: for acyclic G, `quiescent and stalled`
implies `stallRoots != {}`. It is tested on reachable states (states produced by the real
tick from random action sequences), not on arbitrary overlays.

### Task state machine

Three counters with distinct meanings:
- `launches`: one per spawned process, monotone, never reset. Names the branch and the
  worktree: `task/<id>/l<launches>`.
- `attempts`: the failure budget. Increments when an attempt ends in failed by the
  agent's doing or the verifier's red check. Does not increment on daemon-caused
  relaunch or on integration conflict. Reset to 0 on human unblock, reopen, or uncancel.
- `integrationRetries`: increments on rebase conflict. Reset with attempts.

Lease: `{ launchId, token, claimedAt, spawnedAt?, expiresAt, baseSha, graphRev }`.
Lease TTL is the maximum tolerable silence. Heartbeat, any API call, and an open
long-poll renew it.

| From | To | Whose intent | Trigger |
|---|---|---|---|
| unstarted | blocked | orchestrator | brief validation failed (insufficientSpec, missing slots), or remediation candidate awaiting review (needsDecision) |
| unstarted | running | orchestrator | ready, brief valid, slot admitted; launch created |
| running | submitted | agent | report submit accepted; worktree clean; sealedSha recorded |
| running | failed | agent | report fail; attempts++ |
| running | blocked | agent | block delivered via fallback file, process exited |
| running | waiting | agent | block via long-poll; run slot released |
| running | failed | orchestrator | process dead with no report, or lease expired; attempts++ |
| waiting | running | orchestrator | answer persisted and a slot admitted; long-poll completes |
| waiting | blocked | orchestrator | maxWait elapsed or process dead; question and any answer kept |
| submitted | done | verifier | publishedSha recorded |
| submitted | failed | verifier | checks red, undeclared empty diff, missing acceptance evidence, or integration cap hit; attempts++ |
| submitted | unstarted | verifier | rebase conflict under cap; integrationRetries++; next launch briefed with conflict context |
| failed | unstarted | orchestrator | attempts < maxAttempts (default 2) |
| failed | blocked | orchestrator | attempts exhausted |
| blocked | unstarted | human | unblock or answer; answer attached to next brief; budgets reset |
| done, cancelled | unstarted | human | reopen or uncancel, only if revocable; budgets reset |
| any non-terminal | cancelled | human | cancel {release}; live process reaped next tick; queued verifier job dropped |
| milestone unstarted | done | orchestrator | closure satisfied, not gated; iterate to fixed point |
| milestone unstarted | submitted | orchestrator | closure satisfied, gated; reviewVersion++, integrationSha pinned, tagged |
| milestone submitted | done | human | accept, bound to the pinned sha and version |
| milestone submitted | blocked | human | reject {note}; reason milestoneRejected |

Milestone rejection never retries on its own. Repair is a human edit upstream (new tasks
as deps of the milestone, which is a compatible edit because a blocked milestone is not
started) followed by unblock. The milestone is due again only when the new deps are done,
and it is then submitted as a new review version against a new sha.

The orchestrator is the sole writer of the overlay. Agents and humans submit intents as
events. Blocked reasons are structured: `needsDecision | needsAccess | impossible |
dependencyCancelled | outOfScope | insufficientSpec | milestoneRejected`.

Every launch is a fresh process. "Resume" after blocked is a new launch with the answer
in the brief. Resume after waiting is the same process, re-admitted.

### Agent contract

The brief is standalone (the agent cannot tell orchestrator from human launch). The
report is the claim; git is the evidence. The agent commits; the orchestrator seals.

Brief, written to `<worktree>/.orchestrator/brief.md` and `brief.json` before launch:
task payload verbatim; acceptance criteria; definition of done (commit all work on the
launch branch, never merge or touch the integration branch, declare a no-op explicitly,
terminate after the report is accepted); workspace facts (path, branch, baseSha,
integration branch); direct deps' completion reports and released cancellations with
reasons; attempt context when present (prior failure, verifier output, conflict details
naming files and the sibling that landed, the human's answer); API base URL, launch token,
fallback report path, and the instruction to stop immediately on a 401.

Agent API on loopback. Bearer token per launch. Every mutating call carries `seq`, a
per-launch monotone integer. The server stores `(launchId, seq) -> response` in the same
transaction as the event and returns the stored response on replay, so a lost ack is safe
to retry.

```
POST /v1/launches/:id/heartbeat  { progress? }
POST /v1/launches/:id/report     { seq, kind: submit|fail, ...body }
POST /v1/launches/:id/block      { seq, kind, message, options? }     -> long-poll
                                 -> { answer } | { timeout } | 401
GET  /v1/launches/:id/inbox      -> { notices: [] }                     (pull, not push)
POST /v1/launches/:id/log        { text }

submit { summary, interfaces, decisions, deviations, followUps, tests,
         acceptance: [{ criterion, evidence }], noChanges?: { justification } }
fail   { tried, why, whatWouldUnblock }
```

Submission sealing. On `report submit` the server inspects the worktree. If it has
uncommitted or untracked changes, the call is rejected with 409 and the file list, and
the agent commits and resubmits. If clean, the branch head is recorded as `sealedSha`
and the task is submitted. Commits made after sealing are ignored. If `sealedSha` equals
`baseSha` the report must carry `noChanges`; otherwise the submission fails as
`emptySubmission`. When the brief has acceptance criteria, `acceptance` must cover each
one or the submission fails as `missingAcceptanceEvidence`. These are structural checks.

Block and resume. `block` persists the question and moves the task to waiting, releasing
its run slot. An operator answer is persisted first. The scheduler then admits the task
like any other claim, resumables before new launches, and only on admission does the
task return to running and the long-poll complete. A dropped connection is replayed by
re-issuing `block` with the same seq, which returns the stored answer once admitted.
`maxWait` moves the task to blocked with the question preserved; an answer that arrives
later turns into unblock-with-answer and a new launch.

Fallback. The MCP shim and the brief both say: retry the API with backoff for the retry
window; after that, write `.orchestrator/report.json` and exit. The fallback file carries
`{ launchId, seq, kind: submit|fail|block, ...body }`. Recovery applies it on finding the
process dead. A fallback `block` becomes blocked with the question.

MCP façade: a stdio server launched per agent, exposing the five operations as tools and
forwarding to HTTP with the token from its environment. It retries through daemon
restarts for the retry window before surfacing an error.

Brief validation. The template declares slots `{ source, required, minLength }`. It runs
at ready (default) or at ingest (strict). On insufficient: `block` ->
blocked(insufficientSpec, missing) or `remediate` -> planning-model hook produces the
missing slots, stored as a payload overlay keyed by graph rev. `remediateMode: review`
(default) lands the candidate as blocked(needsDecision); `auto` spawns. v1 ships the hook
interface and the block default. A model-backed remediator is a follow-up.

### Workspace and integration

One repo per instance. The daemon's primary clone keeps the integration branch checked
out and is never used for work, so an agent worktree cannot check that branch out. One
worktree per launch from the shared object store, directory named by launch id, removed
after the launch ends. The branch is retained.

The orchestrator is the merge queue. The verifier processes submitted tasks in order,
one job at a time, as a durable job with states
`queued -> checking -> verified -> publishing -> published | failed | conflict`:
1. Temp worktree at the current integration head. Rebase `sealedSha` onto it. Conflict
   -> `conflict`; the task returns to unstarted with context, or fails at the cap.
2. Run the check command with a timeout on the rebased tree. Record `verifiedSha`.
3. Squash the rebased range into one commit whose message is the report summary plus
   trailers `Orchestrator-Task: <id>` and `Orchestrator-Launch: <launchId>`. The
   squash tree is byte-identical to the verified tree.
4. Publish with a compare-and-swap ref update, expecting the head observed in step 1.
   If the head moved, requeue from step 1. Record `publishedSha` and the done transition
   in one transaction.

The commit trailers make publication idempotent and detectable. A sweep flags any
commit on the integration branch without a trailer as foreign.

### Runtime and crash safety

Single Node process: reconciliation loop, agent API server, verifier worker, runners,
operator routes. One SQLite store in WAL mode. No in-memory state a restart would lose.
Agent processes are spawned detached with stdio redirected to per-launch log files, so
they survive the daemon's death and are adopted on restart. The daemon's process id is
not their parent for signal purposes; stop is an explicit signal from the runner.

Every external effect sits between two durable records. Recovery runs before the first
tick after start and is idempotent:

| Durable record | External effect | Next record | Recovery when the daemon died between |
|---|---|---|---|
| launch `preparing` | create worktree | launch `launching` | remove the worktree if present; retry |
| launch `launching` | spawn | pid recorded, launch `live` | spawn status unknown: revoke the token, kill any process whose command line contains the launch id, remove the worktree, start a new launch of the same attempt |
| launch `live` | agent runs | report event | process alive: adopt, keep lease. Dead with fallback file: apply it. Dead without: failed, attempts++ |
| event appended with its `(launchId, seq)` response | ack to agent | none | agent retries; replay returns the stored response |
| job `queued` | temp worktree, rebase, check | job `verified` with verifiedSha | remove temp worktree; redo from queued |
| job `verified` | squash | job `publishing` with squashSha and expected head | redo from queued |
| job `publishing` | compare-and-swap ref update | job `published` plus task done, one transaction | inspect the integration branch for the launch trailer: present -> record published and done; absent -> requeue |
| milestone submitted | create tag | milestone row with sha and version | tag creation is idempotent; re-run |

Fencing. A token is valid only for its launch. Recovery revokes tokens it cannot confirm.
A revoked launch's API calls return 401 and the brief tells the agent to stop. Its
commits are on an isolated branch and its worktree is swept, so a surviving orphan can
waste compute but cannot affect correctness. A periodic sweep compares `git worktree
list` and running processes against live launches and removes strays.

Named crash points. A `crashPoint(name)` call at each boundary exits the process when
`ORCH_CRASH_AT` names it, and is a no-op otherwise. Points: `launch.afterRow`,
`launch.afterWorktree`, `launch.afterSpawn`, `launch.afterPid`, `api.afterEventCommit`,
`verify.afterQueued`, `verify.afterRebase`, `verify.afterCheck`, `verify.afterSquash`,
`verify.afterPublish`, `milestone.afterTag`, and `tick.afterPhase<n>`.

The loop ticks on a timer and on event wake. Phases, in order: reconcile leases and
launches; drain verifier results; complete due milestones to a fixed point; admit
resumables, then validate briefs and claim and spawn new launches up to capacity; evaluate
finished, stalled, awaitingReview, and openQuestions. Each transition is one
transaction. Pause is a flag in the store that stops admission. Shutdown is graceful by
default: stop admitting, flush, exit, leaving agents running for adoption. `--reap` kills
them instead.

Graph source is a JSON or YAML file re-read on change and classified as above. Tracker
adapters are separate exporter programs that write that file.

Operator CLI speaks HTTP to the daemon: `status`, `answer`, `cancel [--release]`,
`reopen`, `unblock`, `accept`, `reject`, `pause`, `resume`, `logs`. Every human action is
an event.

### Done versus accepted

`done` means the sealed work was rebased, passed the check command, and was published.
It does not establish that the requested feature exists. v1 makes the gap explicit rather
than closing it:
- The brief's acceptance criteria slot is required by the default template.
- The report must map each criterion to evidence, checked structurally.
- A no-op must be declared with a justification, and an undeclared empty diff fails.
- Gated milestones are where a human judges correctness in v1, against a pinned sha.
- An acceptance-review hook (model or human, per task) has the remediation hook's shape
  and is deferred.

## Implementation

### Stack

TypeScript, Node 22+, ESM, npm. Dependencies: `better-sqlite3` (synchronous, so a claim
or a dedup write is one transaction), `zod` (graph file, config, reports, API bodies,
fallback file), `yaml`, `@modelcontextprotocol/sdk` (shim only). Built-in `node:http`,
`node:child_process`, `node:util` parseArgs. Dev: `vitest`, `fast-check`, `tsx`,
`typescript`.

### Layout

```
orchestrator/
  README.md                         # description + table of contents
  openspec/                         # from `openspec init`; change add-orchestrator-v1 holds the spec
  plans/0-orchestrator-v1/plan.md   # this document
  package.json  tsconfig.json  vitest.config.ts
  src/
    graph/model.ts                  # Node, Graph, rev
    graph/load.ts                   # file -> Graph; validation with cycle path
    graph/query.ts                  # deps, dependents, closure, ready, milestonesDue,
                                    #   incomplete, stalled, stallRoots, revocable, quiescent
    graph/diff.ts                   # compatible vs incompatible reload classification
    state/status.ts                 # Status, Entry, Lease, reasons, counters
    state/transitions.ts            # transition table as data + guards + counter effects
    state/store.ts                  # Store interface: overlay, events, dedup, launches,
                                    #   verifier jobs, reports, payload overlays
    state/sqlite.ts                 # schema, WAL, transactions
    crash.ts                        # crashPoint(name)
    launch/launch.ts                # launch lifecycle: preparing -> launching -> live -> ended
    launch/recovery.ts              # per-boundary recovery, fencing, sweeps
    runner/runner.ts                # AgentRunner { spawn(detached, stdio to files), alive, reap }
    runner/inproc.ts                # in-process fake for pure logic tests (not a gate)
    runner/subprocess.ts            # command-template runner (used by scripted and claude-code)
    workspace/git.ts                # execFile wrapper: worktree, rebase, squash, CAS update-ref,
                                    #   trailer search, tag, status --porcelain
    workspace/workspace.ts          # per-launch worktree lifecycle
    brief/template.ts  brief/compose.ts  brief/validate.ts  brief/remediate.ts
    agent/api.ts                    # zod schemas: operations, reports, fallback file
    agent/server.ts                 # loopback HTTP, token auth, dedup, long-poll, loop wake
    agent/seal.ts                   # worktree cleanliness, sealedSha, no-op and acceptance checks
    agent/mcp-shim.ts               # entrypoint: stdio MCP -> HTTP with retry window
    verify/job.ts  verify/verifier.ts
    loop/schedule.ts                # Policy { filter, order }; FIFO; resumables first
    loop/tick.ts  loop/orchestrator.ts
    operator/routes.ts  operator/cli.ts
    config.ts  main.ts
  test/
    graph/   state/   loop/         # unit, properties, inproc scenarios
    slice/                          # real subprocess + sqlite + git + http scenarios
    crash/                          # crash-injection suite
    agents/scripted.ts              # the scripted agent, behavior from task payload
    fixtures/graphs/*.yaml
```

Standard fixture, with scripted behaviors in payload for slice tests:

```yaml
nodes:
  - { id: T1, title: Schema migration,  deps: [] }
  - { id: T2, title: Feature A API,     deps: [T1] }
  - { id: T3, title: Feature B API,     deps: [T1] }
  - { id: T4, title: Feature A UI,      deps: [T2] }
  - { id: T5, title: Changelog,         deps: [] }
  - { id: MVP, kind: milestone, gated: true, deps: [T3, T4] }
```

Scripted agent behaviors (selected by `payload.behavior`): `commitAndSubmit`,
`submitDirtyThenFix`, `fail`, `blockThenExit`, `blockAndWait`, `hang`, `exitSilently`,
`noopDeclared`, `noopUndeclared`, `conflictWith:<file>`, `offlineSubmit` (fallback file
only), `ignore401` (keeps running after revocation, to prove isolation). The agent appends
its pid and launch id to a pid log for the crash suite.

### Phases

Each phase ends with its tests green. The gate for the project is phase 3c.

**Phase 0: planning artifacts.** The first deliverable, using the installed OpenSpec
1.5.0 CLI and its default spec-driven schema (proposal, specs, design, tasks). The
bundled templates are at the paths `openspec templates` prints.

1. `openspec init --tools claude --profile core` at the repo root. Creates `openspec/`
   with `config.yaml`, `specs/`, `changes/`, and the `/opsx:*` commands for Claude Code.
2. `openspec new change add-orchestrator-v1`.
3. Write the artifacts in `openspec/changes/add-orchestrator-v1/`:
   - `proposal.md`: Why, What Changes, Capabilities (six new, none modified), Impact.
   - `specs/<capability>/spec.md`, one per capability, each a `## ADDED Requirements`
     section of `### Requirement:` blocks in SHALL/MUST language, every requirement with
     at least one `#### Scenario:` in WHEN/THEN form. The capabilities and what each
     covers, drawn from the Design section:
     - `task-graph`: graph file loading and validation; ready, milestonesDue, incomplete,
       stalled, stallRoots; milestone fixed point and gating; graph revision pinning;
       compatible versus incompatible reloads; the quiescence property.
     - `task-lifecycle`: states; every transition row, grouped by whose intent; the three
       counters and their reset rules; leases and TTL; retry and exhaustion; the
       revocable guard; cancellation with release; milestone accept and reject.
     - `agent-protocol`: brief contents; the five operations; token scoping and 401
       fencing; dedup by launch and seq; sealing and the 409 path; declared no-op;
       acceptance evidence; block, answer, admission, resume, and replay; maxWait;
       the fallback file; MCP façade retry window; brief validation and remediation modes.
     - `integration-pipeline`: primary clone and worktree per launch; verifier job
       states; rebase, check, squash, compare-and-swap publish; trailers; conflict retry
       and cap; foreign commit sweep; milestone tagging at a pinned sha.
     - `crash-recovery`: durable records around each external effect; recovery per
       boundary; adoption of confirmed launches; revocation and kill by launch id;
       worktree and process sweeps; named crash points; the convergence invariants.
     - `operator-control`: operator commands and their events; status report contents;
       pause and resume; graceful shutdown and `--reap`; the sole-writer rule.
   - `design.md`: Context; Goals and Non-Goals; Decisions with the alternatives
     considered (projection over pruning, live peer over batch, orchestrator merge queue
     over agent or human merge, adoption over tethering, compatible edits over a frozen
     graph, launches distinct from attempts, sealing, SQLite, TypeScript, file source
     with external exporters); Risks and trade-offs as risk then mitigation; Open
     Questions listing the deferred topics.
   - `tasks.md`: numbered groups mirroring phases 1 to 5 below, every item `- [ ] X.Y`.
4. `openspec validate --all --strict` passes and `openspec status --change
   add-orchestrator-v1` shows all four artifacts complete.
5. `plans/0-orchestrator-v1/plan.md`: this document, verbatim.
6. `README.md`: one paragraph on what the project is, then a table of contents linking
   the proposal, each capability spec, the design, the tasks, and the plans directory.

**Phase 1: scaffold and graph.** Package, tsconfig, vitest, fixtures, `crash.ts`. Then
`model`, `load`, `query`, `diff`. Tests: fixture loads; cycle,
self-loop, duplicate, dangling rejected with useful messages; `closure(MVP)` is
`{T1,T2,T3,T4}`; reload classification for each compatible and incompatible edit;
fast-check over random DAGs: ready contains only tasks with satisfied deps; marking a
ready node done never removes another node from ready; milestone fixed point completes
chained automatic milestones in one pass.

**Phase 2: state, store, loop logic.** `state/*`, `loop/*`, `runner/inproc`. The
transition table is data and one function checks it. Tests: every row allowed and every
non-row rejected; counter effects per row; revocable across safe and unsafe dependents;
two concurrent claims yield one lease; dedup returns the stored response; event log and
overlay agree after reopening the database. Inproc scenarios on the fixture: happy path;
fail, retry with context, blocked; cancel without release leaves T2 and T3 in stallRoots,
with release they run; reopen refused while a dependent runs, allowed after it fails;
gated MVP reject then repair then accept at a new version; pause stops admission;
waiting frees a slot and resume requires admission with one slot. Property on reachable
states: random action sequences through the tick, then `quiescent and stalled` implies
`stallRoots` non-empty.

**Phase 3a: launch, API, recovery.** `launch/*`, `runner/subprocess`, `workspace/*`,
`agent/server`, `agent/seal`, minimal `brief/compose` (json only). Scripted agent over
real worktrees and loopback HTTP. Tests: dirty submit gets 409 then succeeds; sealing
ignores later commits; undeclared no-op fails and declared passes; missing acceptance
evidence fails; token scoping; replay of the same seq; block, answer, admission, resume;
maxWait degrades to blocked and the later answer becomes a new launch; offline submit
applied on process exit; revoked launch's calls return 401 and its commits stay on its
branch; orphan worktree sweep.

**Phase 3b: verifier and publication.** `verify/*`. Against a temp repo: clean merge is
one squash commit with trailers and the verified tree; red check fails with output;
conflict with a sibling becomes a retry whose brief names the files and sibling; cap hit
fails; CAS failure after head movement requeues; foreign commit sweep flags a manual
commit; gated milestone tags at the pinned sha.

**Phase 3c: crash suite.** `test/crash`. The harness runs the daemon as a subprocess with
`ORCH_CRASH_AT` set to each named point in turn, waits for exit, restarts without it, and
waits for finished. Assertions after every point: the pid log never shows two live
processes for one task at once; the integration branch has exactly one trailer commit per
task; no stray worktrees or temp worktrees; store invariants hold; the outcome equals the
no-crash run. This suite is the project gate.

**Phase 4: brief, shim, operator.** `brief/template`, `brief/validate`,
`brief/remediate` (hook plus block default), `agent/mcp-shim`, `operator/*`. Tests:
validation blocks with the missing slot list; review-mode candidate lands as
needsDecision and unblock applies it; the shim exposes five tools, forwards, and retries
through a daemon restart; every CLI command produces its event.

**Phase 5: Claude Code runner and end to end.** Verify headless flags against
`claude --help` before writing the template. Toy repo plus fixture: scripted agents
first, then Claude Code on a three-task graph; the integration log shows one trailer
commit per task and `status` reports finished.

## Verification

- Phase 0: `openspec validate --all --strict` passes, `openspec status --change
  add-orchestrator-v1` reports proposal, specs, design, and tasks complete, every
  README link resolves, and `plans/0-orchestrator-v1/plan.md` matches this file.
- Per phase, `npm test` green, including properties.
- Phase 3c is the gate: every named crash point converges to the no-crash outcome with
  the four invariants above.
- Reachable-state stall property from phase 2 is re-run over the slice harness in 3a.
- End to end at phase 5 as described, plus `--reap` shutdown and adoption after a plain
  restart with agents mid-task.

## Deferred, with interfaces reserved

- **Tracker sync (9).** Exporters write the graph file. Open: status and remediated
  brief write-back.
- **Scheduling policy (5).** `Policy { filter, order }` with FIFO and resumables-first.
  Later: critical path, declared file scopes for conflict prediction, milestone priority,
  budgets.
- **Health (7).** Leases, heartbeat, and the pid log exist. Later: progress signals, stuck
  detection, cost ceilings, the stuck-diagnosis hook, the `baseMoved` notice.
- **Graph mutation (8).** Compatible-edit rules exist. Later: cascade invalidation on
  reopen, auto milestones transparent to the revocable guard, agent-proposed tasks.
- **Hooks.** Conflict resolution, failure triage, and acceptance review share the
  remediation hook's shape and a human default.

## Review findings and responses

| Finding | Response in this plan |
|---|---|
| Daemon death between spawn and pid record launches a duplicate agent; git can advance before SQLite records completion | Durable launch and verifier job records around every external effect; per-boundary recovery table; token revocation and kill-by-launch-id for unconfirmed spawns; adoption of confirmed survivors; CAS publication with commit trailers; crash-point injection suite as the project gate |
| A submission can pass with an empty branch diff | Agent commits, orchestrator seals: 409 on a dirty worktree, `sealedSha` recorded, verified tree is the published tree, undeclared empty diff fails, declared no-op requires justification |
| Table omits brief-validation and conflict-under-cap transitions; counters conflated | Rows added for unstarted -> blocked and submitted -> unstarted; `launches`, `attempts`, `integrationRetries` defined with increment and reset rules |
| Resume after waiting bypasses the concurrency limit | Answer persisted first; resume requires scheduler admission, resumables first; replay by re-issuing `block` with the same seq; daemon restart replays from the store |
| Milestone rejection loops through generic retry | Reject goes to blocked(milestoneRejected), never retried automatically; repair is upstream edit plus unblock; reviews and tags bound to a pinned sha and version |
| Graph reload can change the meaning of started work | Every launch pins a graph rev; compatible-edit rules; incompatible reloads rejected whole; removing a started node requires cancel first. Chosen over a full freeze so follow-up tasks can be added mid-run |
| Stall property fails on chained automatic milestones | Milestone completion to a fixed point; `quiescent` precondition; property tested on reachable states |
| API dedup and fallback schema incomplete | `(launchId, seq)` dedup with stored responses; fallback file covers submit, fail, and block |
| Mock-only phase cannot prove crash guarantees | Build order changed: invariants, then a real subprocess, SQLite, git, verification slice with crash injection. The in-process fake stays for fast logic tests and is not the gate |
| Green integration is not task correctness | "Done versus accepted" section: required acceptance criteria, structural evidence check, declared no-op policy, human judgment at gated milestones, acceptance-review hook deferred |
