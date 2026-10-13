# orchestrator

An orchestrator that runs many coding agents in parallel from a dependency graph of tasks against one repository. Dependencies gate admission. Each agent works in its own git worktree and reports through a local API. Humans resolve blockers and review milestones. A task is done only after its sealed work has been rebased, checked, and published to the integration branch. The orchestrator itself is a static TypeScript daemon with named hook points for model-backed judgment, designed to converge to the same outcome after a crash at any point. Task graphs are imported from Linear or Jira through the session's own tracker connector, and progress is mirrored back to the tracker.

## Running locally

Prerequisites: Node 22 or newer, git, and, for real agents, the Claude Code CLI (`claude`) logged in. Scripted agents need nothing else.

```
git clone git@github.com:autodidacticon/orchestrator.git && cd orchestrator
npm install
npm run build
npm link            # puts orchestrator, orchestrator-ctl, orchestrator-mcp, orchestrator-mcp-shim on PATH
npm test            # unit, slice, and crash-injection suites with scripted agents; no model calls
```

### From a terminal

1. In the repository you want to work on, write `orchestrator.yaml` (every key is optional):

   ```yaml
   integrationBranch: main
   checkCommand: npm test          # run on every rebased submission before it is published
   capacity: 2                     # agents in parallel
   budgets:
     maxLaunchMs: 7200000          # 2 h per launch
     maxRunCostUsd: 20             # pause admission when the run has spent this much
   ```

2. Start the daemon for that repository. It records run data under `~/.orchestrator/runs/<id>/` and prints the graph file path:

   ```
   cd /path/to/your/repo
   orchestrator-ctl start          # {"started": true, "url": "http://127.0.0.1:...", "graphPath": "~/.orchestrator/runs/<id>/graph.yaml", ...}
   ```

3. Write the task graph to that `graphPath`. The daemon re-reads it on change. Every task needs a description and acceptance criteria, or it is blocked as under-specified:

   ```yaml
   nodes:
     - id: T1
       title: Add the schema migration
       description: Create the users table migration and the model.
       acceptanceCriteria: [migration applies cleanly, model has unit tests]
       deps: []
     - id: T2
       title: Expose the users API
       description: Add GET and POST /users on top of T1's model.
       acceptanceCriteria: [endpoints documented, integration test passes]
       deps: [T1]
     - id: MVP
       kind: milestone
       gated: true                 # a human reviews and accepts the pinned commit
       deps: [T2]
   ```

4. Operate the run from the same terminal:

   ```
   orchestrator-ctl status                         # sets by state, stall roots, open questions, stuck tasks, cost
   orchestrator-ctl answer T1 "use sqlite"         # answer an agent's question
   orchestrator-ctl logs T1                        # the agent's captured output
   orchestrator-ctl nudge T1 "commit what you have"
   orchestrator-ctl accept MVP --sha <sha> --version 1   # or: reject MVP --note "..."
   orchestrator-ctl reopen T1 [--cascade]
   orchestrator-ctl proposals | accept-proposal <id> | reject-proposal <id> --note "..."
   orchestrator-ctl pause | resume [--override-budget]
   orchestrator-ctl mode pull | claim w1 | release <launchId> --reason "..."
   orchestrator-ctl stop [--reap]                  # graceful: agents keep running and are adopted on the next start
   orchestrator-ctl runs                           # every run under ~/.orchestrator
   ```

   To run the daemon in the foreground instead, `orchestrator --repo .` (SIGTERM stops it gracefully). To keep everything inside one directory, use a config with explicit paths and `orchestrator --config orchestrator.yaml` with `repoPath`, `graphPath`, and `dataDir` set; then pass `--data-dir` to `orchestrator-ctl`.

By default agents are headless Claude Code sessions (`runnerCommand`), each in its own git worktree with the brief on stdin and the agent API as an MCP server. For a dry run without model calls, point `runnerCommand` at the scripted agent: `node --import <repo>/node_modules/tsx/dist/loader.mjs <repo>/test/agents/scripted.ts {briefJson}`, and give each task a `behavior` such as `commitAndSubmit`, `blockAndWait:<question>`, or `fail`.

### From a Claude Code session

Load the plugin and use its skills: `import` turns a Linear or Jira epic into the graph with the session's own tracker connector, `run` starts the daemon and monitors it (questions, reviews, stuck tasks, proposals, tracker mirroring), `work` has the session's own subagents execute the launches through a bundled workflow, and `review` judges a milestone's pinned commit. The plugin's MCP server runs `orchestrator-mcp`, so the package must be on PATH first (`npm link` above, or a global install).

```
claude --plugin-dir /path/to/orchestrator/hosts/claude-code          # from a checkout
claude plugin marketplace add autodidacticon/orchestrator            # or install from this repository's marketplace
claude plugin install orchestrator@orchestrator
```

Who executes launches is `runner.mode`: `spawn` (default) has the daemon run headless Claude Code agents; `pull` parks each prepared launch until a worker claims it (`orchestrator-ctl claim <workerId>`, the `claim` tool, or the `work` skill's workflow); `mixed` parks for `runner.claimWindowMs` (default 60 s) and then spawns. `orchestrator-ctl mode <mode>` or `start` with `mode` switches a running daemon. A claimed launch has no process: its lease is renewed by the worker's API calls and by progress in the worktree, and `release` hands it back (untouched: no attempt spent).

### Tests

`npm test` runs everything that needs no model: unit tests, slices with real subprocess agents, git, and the HTTP API, and the crash-injection suite in `test/crash`, which is the project gate. Three opt-in tests use a real model: `ORCH_E2E_CLAUDE=1 npm test -- test/e2e/claude` runs three Claude Code agents, `ORCH_E2E_CLAUDE_PLUGIN=1 npm test -- test/e2e/plugin` has a Claude Code session operate a run through the plugin, and `ORCH_E2E_CLAUDE_WORK=1 npm test -- test/e2e/work` has a session execute a run in pull mode with two workers through the work skill.

## Behaviour

A task is done once its sealed work has been rebased onto the integration branch, checked, and published as one squash commit with `Orchestrator-Task` and `Orchestrator-Launch` trailers; a gated milestone then waits for a human to accept its pinned commit. The daemon converges to the same outcome after a crash at any named point, and surviving agents are adopted on restart.

Tracker sync. After an import that names its tracker, the daemon derives tracker-bound effects from its own transitions into a durable outbox, in the same transaction as the transition: an issue goes in progress on its first launch, done when its work is published (or, with `tracker.doneAt: milestoneAccepted`, when its gated milestone is accepted), cancelled on cancel; the parent issue follows its first starting child and closes when the milestone is accepted. Comments are posted where a human is needed: an agent's question, a block with its reason, a milestone ready for review, accepted, or rejected (`tracker.commentOnDone` and `tracker.commentOnFail` add completion and failure comments, both off by default). The daemon never talks to a tracker: the `run` skill drains the outbox after every `wait` with the session's Linear or Atlassian tools, mapping states by type, and acknowledges each effect (`outbox`, `ack` tools; `GET /v1/outbox`, `POST /v1/outbox/:id/{ack,nack}` routes; `orchestrator-ctl outbox | ack`). Every comment ends with a marker line, `— orchestrator run <id> · event <n>`, so a drainer can recognise its own comments and never posts one twice. A human reply under a question comment is relayed as the answer (`tracker.answersFromComments`, default on); the first answer wins. Config keys: `tracker.enabled` (`auto` | `always` | `never`), `maxAttempts`, `parentInProgress`, `doneAt`, `commentOnDone`, `commentOnFail`, `answersFromComments`. Status reports `tracker`, `outboxPending`, and `trackerErrors`. Manual check against a sandbox workspace: import an epic with the `import` skill in a Claude Code session connected to Linear or Jira, run it with the `run` skill, and watch the child issues move and the question comment appear; this is not part of `npm test`.

Health. The daemon renews a launch's lease every tick while its process is alive, so a quiet agent is never failed for silence; lease expiry applies only to launches the runner cannot observe. Progress is a worktree fingerprint (head plus status and diff), any API call, or a changed heartbeat text. A launch idle past `health.stuckAfterMs` (default 15 min) is flagged (`stuck` in status and the digest, a `stuck` notice in its inbox, event `launch.stuck`) and idle past `health.stuckFailAfterMs` (default 45 min) is reaped and failed with reason `stuck`, spending an attempt; either threshold at 0 disables that step. `orchestrator-ctl nudge <task> <message>` (also the `nudge` tool) queues a message for the agent's inbox. Budgets: `budgets.maxLaunchMs` (default 2 h) fails an overlong launch with reason `timeBudget`, waiting time excluded; `budgets.maxRunCostUsd` (default 0, unlimited) pauses admission with `pausedReason: costBudget` once the run's cost, read from Claude Code's final JSON per launch, reaches the ceiling, and `resume` is refused until `orchestrator-ctl resume --override-budget` (or `resume` with `overrideBudget`) raises the ceiling by one budget. When a task is published, every other running agent gets a `baseMoved` notice naming the new head and the files it touched, and may rebase its branch onto it; the verifier rebases from the merge base so such branches integrate cleanly (`health.baseMovedNotice` turns the notice off).

Graph mutation. Milestones hold no work, so they never block a reopen: reopening a done task resets every done or submitted milestone downstream (`milestone.reset`), which is reviewed again at its next version once the revised work is published, and dependency edits to such milestones are compatible reloads that reset them the same way. A reopen whose target has started task dependents is refused with the blockers; `orchestrator-ctl reopen <task> --cascade` (or `reopen` with `cascade: true`) records a plan, returns it as `reset: [{ id, from }]`, and the next tick kills running dependents, drops queued verification, and returns done dependents and the target to unstarted with budgets reset. Nothing on the integration branch is reverted: each relaunch is briefed with a revision context naming the prior launch, branch, published commit, and report, and publishes a further trailer commit. Agents may put structured `proposals` (title, description, acceptance criteria, optional deps, scope, labels) in their submit report; they are held pending (`proposals` in status and the digest) until `accept-proposal <id> [--node-id <tracker key>]` appends a task node depending on the proposer, joining its gated milestone when `proposals.joinMilestone` is true (default), or `reject-proposal <id> --note`. A compatible reload that edits a running task's payload sends its agent a `payloadChanged` inbox notice (`graph.payloadChangedNotice`, default true); the pinned brief stays and the next launch uses the new payload.

## Contents

### Requirements

Current specs in `openspec/specs/`, synced from the archived changes `add-orchestrator-v1`, `add-session-operator`, `add-tracker-sync`, `add-health-monitoring`, `add-graph-mutation`, and `add-pull-runner`:

- Capability specs
  - [task-graph](openspec/specs/task-graph/spec.md): loading, validation, external nodes, readiness, milestones, stall detection, revisions, reload compatibility, revocability through milestones and the cascade plan
  - [task-lifecycle](openspec/specs/task-lifecycle/spec.md): states, transitions by actor, admission, counters, leases, retry, reopen guard, cascade reopen, milestone reset and review, cancellation
  - [agent-protocol](openspec/specs/agent-protocol/spec.md): the brief, the API, deduplication, sealing, no-op and acceptance checks, blocking and resume, fallback, fencing, MCP façade, brief validation
  - [integration-pipeline](openspec/specs/integration-pipeline/spec.md): worktrees, the verifier, publication, conflicts, foreign commits, milestone tags
  - [crash-recovery](openspec/specs/crash-recovery/spec.md): durable records, recovery per boundary, adoption, fencing, sweeps, crash points, invariants
  - [operator-control](openspec/specs/operator-control/spec.md): operator routes shared by the CLI and the MCP server, status, run directories, daemon lifecycle, event stream, review bundle, graph import, pause and resume, shutdown, logs
  - [operator-mcp](openspec/specs/operator-mcp/spec.md): the operator MCP server a host session drives: tool set, wait, start, review
  - [graph-import](openspec/specs/graph-import/spec.md): normalized issue records, mapping rules, acceptance criteria extraction, import outcome
  - [host-integration](openspec/specs/host-integration/spec.md): package entrypoints, per-host wrappers, skills
  - [tracker-sync](openspec/specs/tracker-sync/spec.md): the durable outbox of tracker effects, effect kinds and marker, mirroring policy, done semantics, the drainer contract
  - [health-monitoring](openspec/specs/health-monitoring/spec.md): process liveness, progress signals, stuck detection and escalation, the diagnosis hook, launch and run budgets, usage accounting, the base-moved notice
  - [pull-runner](openspec/specs/pull-runner/spec.md): runner modes and the claim window, claim and release, worker identity and idempotent re-claim, access modes with remote reserved
- Archived change `add-orchestrator-v1` (the v1 runtime): [Proposal](openspec/changes/archive/2026-10-12-add-orchestrator-v1/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-orchestrator-v1/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-orchestrator-v1/tasks.md)
- Archived change `add-session-operator` (operate from a Claude Code session): [Proposal](openspec/changes/archive/2026-10-12-add-session-operator/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-session-operator/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-session-operator/tasks.md)
- Archived change `add-tracker-sync` (mirror the run to the tracker): [Proposal](openspec/changes/archive/2026-10-12-add-tracker-sync/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-tracker-sync/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-tracker-sync/tasks.md)
- Archived change `add-health-monitoring` (liveness, stuck detection, budgets): [Proposal](openspec/changes/archive/2026-10-12-add-health-monitoring/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-health-monitoring/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-health-monitoring/tasks.md)
- Archived change `add-graph-mutation` (transparent milestones, cascade reopen, proposals): [Proposal](openspec/changes/archive/2026-10-12-add-graph-mutation/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-graph-mutation/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-graph-mutation/tasks.md)
- Archived change `add-pull-runner` (workers claim launches; the work skill and workflow): [Proposal](openspec/changes/archive/2026-10-13-add-pull-runner/proposal.md), [Design](openspec/changes/archive/2026-10-13-add-pull-runner/design.md), [Tasks](openspec/changes/archive/2026-10-13-add-pull-runner/tasks.md)

Active change:

1. `add-scheduling-policy`: a configurable ordering chain with critical path first, declared file scopes with an overlap filter, deferred candidates in status. [Proposal](openspec/changes/add-scheduling-policy/proposal.md), [Design](openspec/changes/add-scheduling-policy/design.md), [Tasks](openspec/changes/add-scheduling-policy/tasks.md)
