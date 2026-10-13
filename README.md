# orchestrator

An orchestrator that runs many coding agents in parallel from a dependency graph of tasks against one repository. Dependencies gate admission. Each agent works in its own git worktree and reports through a local API. Humans resolve blockers and review milestones. A task is done only after its sealed work has been rebased, checked, and published to the integration branch. The orchestrator itself is a static TypeScript daemon with named hook points for model-backed judgment, designed to converge to the same outcome after a crash at any point. Task graphs will eventually be exported from trackers such as Linear or Jira.

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

The graph file is YAML or JSON: `nodes: [{ id, kind?: task|milestone, gated?, deps: [], description, acceptanceCriteria: [...] }]`.
Agents are launched by `runnerCommand` (default: headless Claude Code with the brief on stdin and the MCP façade). Tests: `npm test`; the crash-injection suite in `test/crash` is the project gate. `ORCH_E2E_CLAUDE=1 npm test -- test/e2e/claude` runs three real Claude Code agents; `ORCH_E2E_CLAUDE_PLUGIN=1 npm test -- test/e2e/plugin` has a real Claude Code session operate a run through the plugin.

## Contents

### Requirements

Current specs in `openspec/specs/`, synced from the archived changes `add-orchestrator-v1` and `add-session-operator`:

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
- Archived change `add-orchestrator-v1` (the v1 runtime): [Proposal](openspec/changes/archive/2026-10-12-add-orchestrator-v1/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-orchestrator-v1/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-orchestrator-v1/tasks.md)
- Archived change `add-session-operator` (operate from a Claude Code session): [Proposal](openspec/changes/archive/2026-10-12-add-session-operator/proposal.md), [Design](openspec/changes/archive/2026-10-12-add-session-operator/design.md), [Tasks](openspec/changes/archive/2026-10-12-add-session-operator/tasks.md)

### Plans

- [plans/0-orchestrator-v1/plan.md](plans/0-orchestrator-v1/plan.md): the v1 implementation plan, including the design decisions, the build phases, and the review findings with their responses
- [plans/1-session-operator/plan.md](plans/1-session-operator/plan.md): operating a run from a Claude Code session: host packaging, per-user run directories, the operator MCP server, tracker import, external nodes
