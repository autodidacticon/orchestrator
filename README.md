# orchestrator

An orchestrator that runs many coding agents in parallel from a dependency graph of tasks against one repository. Dependencies gate admission. Each agent works in its own git worktree and reports through a local API. Humans resolve blockers and review milestones. A task is done only after its sealed work has been rebased, checked, and published to the integration branch. The orchestrator itself is a static TypeScript daemon with named hook points for model-backed judgment, designed to converge to the same outcome after a crash at any point. Task graphs are imported from Linear or Jira through the session's own tracker connector, and progress is mirrored back to the tracker.

## Running

```
npm install && npm run build
# orchestrator.yaml: repoPath, graphPath, dataDir, integrationBranch, checkCommand, capacity ...
orchestrator-ctl start                                     # daemon for this repository; run data under ~/.orchestrator/runs/<id>/
orchestrator-ctl status                                    # also: answer, cancel, reopen, unblock, accept, reject, pause, resume, logs, stop, runs
orchestrator --repo .                                      # or run the daemon in the foreground (SIGTERM stops it; agents are adopted on restart)
```

For use from a Claude Code session, link the package once so its executables are on PATH, then load the host wrapper:

```
npm link                                          # installs orchestrator, orchestrator-ctl, orchestrator-mcp, orchestrator-mcp-shim
claude --plugin-dir /path/to/orchestrator/hosts/claude-code
```

Tracker sync. After an import that names its tracker, the daemon derives tracker-bound effects from its own transitions into a durable outbox, in the same transaction as the transition: an issue goes in progress on its first launch, done when its work is published (or, with `tracker.doneAt: milestoneAccepted`, when its gated milestone is accepted), cancelled on cancel; the parent issue follows its first starting child and closes when the milestone is accepted. Comments are posted where a human is needed: an agent's question, a block with its reason, a milestone ready for review, accepted, or rejected (`tracker.commentOnDone` and `tracker.commentOnFail` add completion and failure comments, both off by default). The daemon never talks to a tracker: the `run` skill drains the outbox after every `wait` with the session's Linear or Atlassian tools, mapping states by type, and acknowledges each effect (`outbox`, `ack` tools; `GET /v1/outbox`, `POST /v1/outbox/:id/{ack,nack}` routes; `orchestrator-ctl outbox | ack`). Every comment ends with a marker line, `— orchestrator run <id> · event <n>`, so a drainer can recognise its own comments and never posts one twice. A human reply under a question comment is relayed as the answer (`tracker.answersFromComments`, default on); the first answer wins. Config keys: `tracker.enabled` (`auto` | `always` | `never`), `maxAttempts`, `parentInProgress`, `doneAt`, `commentOnDone`, `commentOnFail`, `answersFromComments`. Status reports `tracker`, `outboxPending`, and `trackerErrors`. Manual check against a sandbox workspace: import an epic with the `import` skill in a Claude Code session connected to Linear or Jira, run it with the `run` skill, and watch the child issues move and the question comment appear; this is not part of `npm test`.

The graph file is YAML or JSON: `nodes: [{ id, kind?: task|milestone, gated?, deps: [], description, acceptanceCriteria: [...] }]`.
Agents are launched by `runnerCommand` (default: headless Claude Code with the brief on stdin and the MCP façade). Tests: `npm test`; the crash-injection suite in `test/crash` is the project gate. `ORCH_E2E_CLAUDE=1 npm test -- test/e2e/claude` runs three real Claude Code agents; `ORCH_E2E_CLAUDE_PLUGIN=1 npm test -- test/e2e/plugin` has a real Claude Code session operate a run through the plugin.

## Contents

### Requirements

Current specs in `openspec/specs/`, synced from the archived changes `add-orchestrator-v1`, `add-session-operator`, and `add-tracker-sync`:

- Capability specs
  - [task-graph](openspec/specs/task-graph/spec.md): loading, validation, external nodes, readiness, milestones, stall detection, revisions, reload compatibility
  - [task-lifecycle](openspec/specs/task-lifecycle/spec.md): states, transitions by actor, admission, counters, leases, retry, reopen guard, cancellation, milestone review
  - [agent-protocol](openspec/specs/agent-protocol/spec.md): the brief, the API, deduplication, sealing, no-op and acceptance checks, blocking and resume, fallback, fencing, MCP façade, brief validation
  - [integration-pipeline](openspec/specs/integration-pipeline/spec.md): worktrees, the verifier, publication, conflicts, foreign commits, milestone tags
  - [crash-recovery](openspec/specs/crash-recovery/spec.md): durable records, recovery per boundary, adoption, fencing, sweeps, crash points, invariants
  - [operator-control](openspec/specs/operator-control/spec.md): operator routes shared by the CLI and the MCP server, status, run directories, daemon lifecycle, event stream, review bundle, graph import, pause and resume, shutdown, logs
  - [operator-mcp](openspec/specs/operator-mcp/spec.md): the operator MCP server a host session drives: tool set, wait, start, review
  - [graph-import](openspec/specs/graph-import/spec.md): normalized issue records, mapping rules, acceptance criteria extraction, import outcome
  - [host-integration](openspec/specs/host-integration/spec.md): package entrypoints, per-host wrappers, skills
  - [tracker-sync](openspec/specs/tracker-sync/spec.md): the durable outbox of tracker effects, effect kinds and marker, mirroring policy, done semantics, the drainer contract
- Archived change `add-orchestrator-v1` (the v1 runtime): [Proposal](openspec/changes/archive/2026-10-12-add-orchestrator-v1/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-orchestrator-v1/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-orchestrator-v1/tasks.md)
- Archived change `add-session-operator` (operate from a Claude Code session): [Proposal](openspec/changes/archive/2026-10-12-add-session-operator/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-session-operator/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-session-operator/tasks.md)
- Archived change `add-tracker-sync` (mirror the run to the tracker): [Proposal](openspec/changes/archive/2026-10-12-add-tracker-sync/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-tracker-sync/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-tracker-sync/tasks.md)

Active changes, in the order to apply them (each has its own plan under `plans/`):

1. `add-health-monitoring`: process liveness, progress signals, stuck detection with nudge and escalation, wall-time and cost budgets, the baseMoved notice. [Proposal](openspec/changes/add-health-monitoring/proposal.md), [Design](openspec/changes/add-health-monitoring/design.md), [Tasks](openspec/changes/add-health-monitoring/tasks.md)
2. `add-graph-mutation`: milestones transparent to the reopen guard, cascade reopen, structured proposals held for acceptance, the payloadChanged notice. [Proposal](openspec/changes/add-graph-mutation/proposal.md), [Design](openspec/changes/add-graph-mutation/design.md), [Tasks](openspec/changes/add-graph-mutation/tasks.md)
3. `add-pull-runner`: claimable launches, spawn, pull, and mixed modes, worker tools on the operator MCP server, the work skill and workflow, the marketplace manifest. [Proposal](openspec/changes/add-pull-runner/proposal.md), [Design](openspec/changes/add-pull-runner/design.md), [Tasks](openspec/changes/add-pull-runner/tasks.md)
4. `add-scheduling-policy`: a configurable ordering chain with critical path first, declared file scopes with an overlap filter, deferred candidates in status. [Proposal](openspec/changes/add-scheduling-policy/proposal.md), [Design](openspec/changes/add-scheduling-policy/design.md), [Tasks](openspec/changes/add-scheduling-policy/tasks.md)

### Plans

- [plans/0-orchestrator-v1/plan.md](plans/0-orchestrator-v1/plan.md): the v1 implementation plan, including the design decisions, the build phases, and the review findings with their responses
- [plans/1-session-operator/plan.md](plans/1-session-operator/plan.md): operating a run from a Claude Code session: host packaging, per-user run directories, the operator MCP server, tracker import, external nodes
- [plans/2-tracker-sync/plan.md](plans/2-tracker-sync/plan.md): the tracker outbox, mirroring policy, done semantics, and answers from comments
- [plans/3-health/plan.md](plans/3-health/plan.md): liveness, progress signals, stuck escalation, budgets, and the baseMoved notice
- [plans/4-graph-mutation/plan.md](plans/4-graph-mutation/plan.md): transparent milestones, cascade reopen, proposals, and the payloadChanged notice
- [plans/5-pull-runner/plan.md](plans/5-pull-runner/plan.md): claimable launches, runner modes, worker tools, the work skill and workflow, and what remote workers would need
- [plans/6-scheduling/plan.md](plans/6-scheduling/plan.md): the ordering chain, scopes and the overlap rule, and deferred reporting
