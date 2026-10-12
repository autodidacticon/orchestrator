# orchestrator

An orchestrator that runs many coding agents in parallel from a dependency graph of tasks against one repository. Dependencies gate admission. Each agent works in its own git worktree and reports through a local API. Humans resolve blockers and review milestones. A task is done only after its sealed work has been rebased, checked, and published to the integration branch. The orchestrator itself is a static TypeScript daemon with named hook points for model-backed judgment, designed to converge to the same outcome after a crash at any point. Task graphs will eventually be exported from trackers such as Linear or Jira.

## Running

```
npm install && npm run build
# orchestrator.yaml: repoPath, graphPath, dataDir, integrationBranch, checkCommand, capacity ...
node dist/src/main.js --config orchestrator.yaml          # the daemon (SIGTERM stops it; agents keep running and are adopted on restart)
node dist/src/operator/cli.js status --url http://127.0.0.1:<port>
node dist/src/operator/cli.js answer T3 "use postgres"     # answer, cancel, reopen, unblock, accept, reject, pause, resume, logs
```

The graph file is YAML or JSON: `nodes: [{ id, kind?: task|milestone, gated?, deps: [], description, acceptanceCriteria: [...] }]`.
Agents are launched by `runnerCommand` (default: headless Claude Code with the brief on stdin and the MCP façade). Tests: `npm test`; the crash-injection suite in `test/crash` is the project gate. `ORCH_E2E_CLAUDE=1 npm test -- test/e2e/claude` runs three real Claude Code agents.

## Contents

### Requirements

Current specs in `openspec/specs/`, synced from the archived change `add-orchestrator-v1`:

- [Proposal](openspec/changes/archive/2026-10-12-add-orchestrator-v1/proposal.md)
- Capability specs
  - [task-graph](openspec/specs/task-graph/spec.md): loading, validation, readiness, milestones, stall detection, revisions, reload compatibility
  - [task-lifecycle](openspec/specs/task-lifecycle/spec.md): states, transitions by actor, admission, counters, leases, retry, reopen guard, cancellation, milestone review
  - [agent-protocol](openspec/specs/agent-protocol/spec.md): the brief, the API, deduplication, sealing, no-op and acceptance checks, blocking and resume, fallback, fencing, MCP façade, brief validation
  - [integration-pipeline](openspec/specs/integration-pipeline/spec.md): worktrees, the verifier, publication, conflicts, foreign commits, milestone tags
  - [crash-recovery](openspec/specs/crash-recovery/spec.md): durable records, recovery per boundary, adoption, fencing, sweeps, crash points, invariants
  - [operator-control](openspec/specs/operator-control/spec.md): operator commands, status, pause and resume, shutdown, logs
- [Design](openspec/changes/archive/2026-10-12-add-orchestrator-v1/design.md)
- [Tasks](openspec/changes/archive/2026-10-12-add-orchestrator-v1/tasks.md)

### Plans

- [plans/0-orchestrator-v1/plan.md](plans/0-orchestrator-v1/plan.md): the v1 implementation plan, including the design decisions, the build phases, and the review findings with their responses
