## Why

Codex 0.164 installs plugins from marketplaces. With this repository added as one, Codex reads `.claude-plugin/marketplace.json` and installs the Claude Code plugin as `orchestrator@orchestrator`, whose operator server never starts under Codex: its args use `${CLAUDE_PLUGIN_ROOT}`, which Codex does not expand. A plugin's MCP server can only find its files by running with `cwd: "."`, the installed plugin root, and from there the operator server would resolve the plugin cache as its repository. Codex tells the server nothing about the session's project: it advertises no MCP roots, and `PWD` is the shell's launch directory, not `codex -C <dir>`. Without a repository the session can name, a plugin-installed operator cannot serve the user's project (ORC-75, blocking M5).

## What Changes

- Every operator tool takes an optional `repo`, an absolute path inside the project's git repository, resolved to its real top level. Resolution order: the call's `repo`, else the repo the session last passed, else `--repo`, `ORCH_REPO`, or the git top level of the working directory as before. With none of them, the tool fails with a message naming the `repo` argument. `repo` is recorded by the server and never forwarded to the daemon. `start` and `stop` act on the resolved repository rather than the `--repo` flag alone. The server ends its attachment on every daemon it registered with, since a session that passes several repositories attaches to several daemons.
- The Codex and OpenCode skills tell the model to pass `repo`, the session's working directory, on every operator call. The paragraph is identical in both editions, so the OpenCode edition's pinned differences are unchanged.
- `hosts/codex` becomes the Codex plugin `orchestrator-codex`: `.codex-plugin/plugin.json` (version equal to the package's), `.mcp.json` declaring `orchestrator_operator` run from the plugin root with `startup_timeout_sec: 60` and `tool_timeout_sec: 180`, and `hooks/hooks.json` running the two session hooks through `${PLUGIN_ROOT}`.
- `.agents/plugins/marketplace.json` at the repository root lists `orchestrator-codex` from `./hosts/codex`. Codex reads it instead of `.claude-plugin/marketplace.json`, and Claude Code keeps reading its own file.
- `hosts/codex/README.md` leads with the plugin install, keeps the TOML registration as the manual alternative, documents the plugin-keyed approvals `codex exec` needs, and tells users with `orchestrator@orchestrator` installed in Codex to remove it.

## Capabilities

### New Capabilities

### Modified Capabilities

- `operator-mcp`: the "Operator MCP server" requirement adds the `repo` argument, its resolution order, and the refusal.
- `host-integration`: "Codex host" makes the plugin the primary install. New requirements: "Codex plugin manifest" (with the version test), "Codex plugin MCP server", "Codex plugin hooks", "Codex marketplace file", and "Skills pass the repository" (the Codex and OpenCode editions).

## Impact

- `src/operator/mcp-server.ts`, `src/operator/mcp.ts` (usage), `src/runs/runDir.ts` (`gitTopLevel`).
- `hosts/codex/.codex-plugin/plugin.json`, `hosts/codex/.mcp.json`, `hosts/codex/hooks/hooks.json`, `hosts/codex/README.md`, `hosts/codex/skills/*`, `hosts/opencode/skills/*`, `.agents/plugins/marketplace.json`, `README.md`.
- Tests: `test/slice/operator-mcp.test.ts`, `test/host/codex-host.test.ts`.
- A release bumps `hosts/codex/.codex-plugin/plugin.json` with the other versions.
