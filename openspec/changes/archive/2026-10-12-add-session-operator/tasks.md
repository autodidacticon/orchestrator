## 1. Package layout and host wrapper

- [x] 1.1 Add `exports` (`.`, `./daemon`, `./operator-mcp`, `./agent-shim`) and the `orchestrator-mcp` bin to package.json; add `src/index.ts` exporting the core library
- [x] 1.2 Create `hosts/claude-code/.claude-plugin/plugin.json` (name `orchestrator`, version, description, author) and `.mcp.json` declaring server `operator` running `orchestrator-mcp` with `timeout: 180000`
- [x] 1.3 Add `npm run link` guidance to README and verify `claude plugin validate --strict hosts/claude-code` passes
- [x] 1.4 Test: package exports resolve and all four executables print usage with `--help`

## 2. Run directory and daemon lifecycle

- [x] 2.1 Implement `src/runs/runDir.ts`: `ORCH_HOME`, run id from the repository real path, `repo` file, resolution from `--repo`, `ORCH_REPO`, or git top level
- [x] 2.2 Implement `src/runs/lifecycle.ts`: idempotent `start` (pid file, health check, detached spawn, bounded wait), `stop` via the `shutdown` route with signal fallback, `runs` listing
- [x] 2.3 Daemon: record the chosen port in the store and reuse it when free; add `POST /v1/shutdown { reap }`; add `--run-dir` and config resolution (`<repo>/orchestrator.yaml` when present)
- [x] 2.4 CLI: `start`, `stop [--reap]`, `runs`, `--repo` flag; resolve the daemon URL through the run directory
- [x] 2.5 Tests: same repo resolves to one run from a subdirectory and a symlink; start twice spawns once; stale pid file; port reuse keeps a mid-task scripted agent on the live channel; `runs` lists two runs with one alive

## 3. External nodes and graph import

- [x] 3.1 Graph model and loader: `kind: external` with `done`; validation; `satisfied` treats external by flag; external never in `ready` or `milestonesDue`; `external` set in status; reload classification treats external as not started; stallRoots includes tasks blocked by open externals
- [x] 3.2 Update the task-graph property tests and fixtures for external nodes
- [x] 3.3 Implement `src/import/mapping.ts`: normalized record schema (zod), mapping rules, acceptance-criteria splitting with configurable heading, in-progress policy, summary
- [x] 3.4 Daemon route `PUT /v1/graph`: validate, atomic write of the run's graph file, immediate reload, return revision and classification
- [x] 3.5 Tests: mapping unit tests for the mixed-epic scenario, criteria parsing, malformed records, in-progress policy; route tests for accepted, rejected, and invalid imports

## 4. Event stream and review bundle

- [x] 4.1 Daemon route `GET /v1/events` with `after`, `kinds`, `limit`, `wait` (capped at two minutes) and the digest; wake waiting requests on event append
- [x] 4.2 Daemon route `GET /v1/milestones/:id/review` returning sha, version, tag, baseline, diff stat, and closure summaries
- [x] 4.3 Status report additions: external set, run directory, graph path, daemon pid and URL, latest event sequence
- [x] 4.4 Tests: long-poll returns on the next event and on timeout; review bundle for a submitted milestone and error otherwise

## 5. Operator MCP server

- [x] 5.1 Implement `src/operator/mcp.ts`: stdio server, run resolution, seventeen tools with zod input schemas, JSON text results, error on no daemon with the start hint
- [x] 5.2 Implement `wait` with `afterSeq`, `timeoutMs` default sixty seconds capped at ninety, and `until`
- [x] 5.3 Implement `import_issues` (records in, mapping, `PUT /v1/graph`) and `import_graph` (raw content in)
- [x] 5.4 Tests over a real stdio MCP client: tool list, `start` on a fresh repo, `import_issues` then `status`, `wait` returning on a scripted agent's question, `review` then `accept`, cap enforced

## 6. Skills and end to end

- [x] 6.1 Write `hosts/claude-code/skills/import/SKILL.md`: tracker prerequisite check, what to fetch for Linear and for Atlassian, record building, `import_issues`, summary
- [x] 6.2 Write `hosts/claude-code/skills/run/SKILL.md`: `start`, the `wait` loop, surfacing questions, invoking review, stopping conditions, keeping digests out of context
- [x] 6.3 Write `hosts/claude-code/skills/review/SKILL.md`: `review`, judging against acceptance criteria, `accept` or `reject` with a note, optional reviewer fan-out when workflows are enabled
- [x] 6.4 Scripted end to end: `start` via the MCP server, `import_graph` with the standard fixture, scripted agents, `wait` through completion, `review` and `accept`, `stop`
- [x] 6.5 Opt-in end to end in a real Claude Code session with `--plugin-dir`: import a small epic from Linear, run with real agents, review and accept; documented in README
