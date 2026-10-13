# Operate from a Claude Code session: plan for change `add-session-operator`

## Context

v1 (`plans/0-orchestrator-v1/plan.md`) delivered a durable local daemon, a CLI, a verified
integration pipeline, and a real Claude Code runner. The next user is inside a coding-agent
session with a tracker connected and wants to import an epic, start a run, and monitor it
from there. Conversation 10 on 2026-10-12 settled the design. This document records the
decisions and their reasoning; the OpenSpec change `add-session-operator` holds the
requirements, design record, and task checklist.

The conversation also reordered the remaining work. Tracker sync (9) was opened first, then
set aside once the session use case made clear that import belongs in the session and
headless sync comes later. Scheduling (5), health (7), graph mutation (8), and a pull-based
runner for workflow agents follow this change.

## Decisions

1. **The session is the operator; the daemon stays the durable process.** The session gets
   an operator MCP server and skills. The daemon is unchanged in role and can outlive any
   session, which is what adoption and crash recovery were for.
2. **Thin per-host wrappers over executables on PATH.** The npm package installs
   `orchestrator`, `orchestrator-ctl`, `orchestrator-mcp`, and `orchestrator-mcp-shim`.
   `hosts/claude-code/` is a plugin of configuration and skills only, referencing
   `orchestrator-mcp` by name. Rejected: repo root as the plugin (welds the plugin to the
   native dependency; a later move), and a monorepo (no code consumer justifies it).
   Multi-host intent is explicit: other ecosystems get their own `hosts/<host>/`.
3. **Run data per user, keyed by the repository's real path.** `~/.orchestrator/runs/<id>/`
   with `ORCH_HOME` override, a `repo` file for reverse lookup, and a `runs` listing. The
   repository is never touched. Chosen over an ignored in-repo directory.
4. **Tracker access stays in the session; mapping is code.** The import skill requires the
   Linear or Atlassian MCP server, fetches, and passes normalized records to a tool that
   maps, validates, and writes through the daemon. Our process becomes an MCP client of the
   vendor servers only later, for headless sync, so no tracker SDK ever enters the project.
5. **`wait` is a bounded long-poll with a digest.** Sixty seconds default, ninety cap, below
   Claude Code's two-minute auto-background threshold. Sessions hold digests, not logs.
6. **External nodes.** `kind: external` with a `done` flag covers outside-epic blockers,
   already-done children, and children a human has in progress. Never scheduled, always
   reload-compatible.
7. **Two daemon fixes ride along.** Port reuse across restarts so surviving agents reconnect,
   and a reaping `shutdown` route.

## Implementation

Six task groups in `openspec/changes/add-session-operator/tasks.md`:

1. Package layout and host wrapper (exports, fourth bin, plugin manifest and MCP config,
   `claude plugin validate --strict`).
2. Run directory and daemon lifecycle (resolution, `start`, `stop`, `runs`, pid file, port
   reuse, shutdown route, config resolution).
3. External nodes and graph import (model and queries, mapping module, `PUT /v1/graph`).
4. Event stream and review bundle (`GET /v1/events` with wait and digest,
   `GET /v1/milestones/:id/review`, status additions).
5. Operator MCP server (seventeen tools, `wait`, `import_issues`, tests over a real stdio
   client).
6. Skills and end to end (three SKILL.md files, scripted end to end through the MCP server,
   opt-in real-session end to end with `--plugin-dir`).

Gate: group 5's MCP client tests plus group 6's scripted end to end. The crash suite from v1
keeps running unchanged; group 2's port-reuse test extends the restart story it covers.

## Verification

- `npm test` green including the v1 suites; `claude plugin validate --strict hosts/claude-code`
  passes; all four executables answer `--help`.
- Scripted end to end: in a fresh repository, `start`, `import_graph`, `wait` through
  completion, `review`, `accept`, `stop`, all through the MCP server, with the integration
  branch showing one trailer commit per task.
- Opt-in: a real Claude Code session with `--plugin-dir hosts/claude-code` imports a small
  Linear epic, runs it with real agents, and reviews the milestone.

## Deferred

- Tracker sync as a headless MCP client of the vendor servers, status mirroring, comments
  in both directions (conversation 9).
- Scheduling policy (5), health monitoring (7), graph mutation (8).
- Pull-based runner so workflow agents can execute launches.
- Marketplace distribution and wrappers for other hosts.
