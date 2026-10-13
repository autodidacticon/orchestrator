## Why

v1 runs from a terminal: a daemon, a CLI, and a graph file someone wrote by hand. The people who will actually use it are already inside a coding-agent session with their tracker connected. They want to point at an epic, start a run, and watch it from where they are. Conversation 10 (2026-10-12, `plans/1-session-operator/plan.md`) settled how: the daemon stays a durable local process, the session talks to it through an operator MCP server, and thin per-host wrappers (Claude Code first) package the skills. Tracker access stays in the session; the mapping from issues to a graph is code.

## What Changes

- Package the project for hosts: subpath exports for the core library and four executables on PATH (`orchestrator`, `orchestrator-ctl`, `orchestrator-mcp`, `orchestrator-mcp-shim`). A Claude Code plugin under `hosts/claude-code/` with a manifest, an MCP config that runs `orchestrator-mcp`, and three skills: import, run, review. Other hosts get their own small directories later.
- Move run data out of the repository into a per-user run directory keyed by the repository's real path, with discovery from any session or host in that repository and a `runs` listing.
- Give the daemon a lifecycle a session can drive: idempotent `start`, graceful or reaping `stop`, a pid file, health check, and reuse of its recorded port across restarts so surviving agents reconnect instead of falling back to report files.
- Add an operator MCP server exposing every operator operation as a tool plus four that only a session needs: `start`, `stop`, `import_issues`, `wait`, and `review`.
- Add `external` nodes to the graph model: dependencies not orchestrated here, satisfied when the tracker says they are done. Also used for issues already completed or in progress by a human.
- Add deterministic tracker-to-graph mapping: normalized issue records in, a validated graph file out, written through the daemon, with the reload classification returned.
- Add two daemon routes the session needs: an event stream with long-poll and digest, and a milestone review bundle.

## Capabilities

### New Capabilities
- `operator-mcp`: the stdio MCP server a host session runs, its tools, discovery of the daemon, `wait` semantics bounded to stay a foreground call, and `review`.
- `graph-import`: the normalized issue record, the mapping rules (tasks, deps, external nodes, the epic as a gated milestone, acceptance criteria from a description heading), validation, and what the import returns.
- `host-integration`: package exports and executables, the per-host wrapper layout, the Claude Code plugin and its skills, and what a skill must check before acting.

### Modified Capabilities
- `task-graph`: graph file loading accepts `kind: external` with a `done` flag; dependency semantics treat an external node as satisfied iff done; external nodes are never scheduled.
- `operator-control`: the operator interface gains the MCP server and new operations; the status report gains run and daemon facts; shutdown gains a reaping route; new requirements for the run directory, daemon lifecycle and discovery, the event stream, the review bundle, and graph import through the daemon.

## Impact

- `package.json` gains `exports` and a fourth bin. New source: `src/operator/mcp.ts`, `src/import/mapping.ts`, `src/runs/` (run directory, lifecycle), new routes in `src/operator/routes.ts`, `external` handling in `src/graph/*`.
- New directory `hosts/claude-code/` with `.claude-plugin/plugin.json`, `.mcp.json`, and `skills/{import,run,review}/SKILL.md`, validated with `claude plugin validate --strict` and loaded with `claude --plugin-dir`.
- Run data moves to `~/.orchestrator/runs/<id>/` (`ORCH_HOME` overrides). Existing `.orchestrator-run` directories are not migrated; v1 had no users.
- The import skill requires a tracker MCP server (Linear or Atlassian) connected in the session and refuses clearly otherwise. No tracker SDKs are added.
- Marketplace distribution of the plugin is enabled by the executable-on-PATH contract but is not part of this change.
