## Why

A Codex session cannot be the operator today. Codex has no plugin manifest the orchestrator ships, no `.mcp.json`, and no `${CLAUDE_PLUGIN_ROOT}`. The skills assume Claude Code: they name Bash as a tool, run a Workflow of session subagents, read `CLAUDE.md` for the test command, and name Claude models as defaults. Codex's default `tool_timeout_sec` of 60 would also abandon the operator server's `wait` (60 s default plus latency) and `launch_block` (up to the 90 s cap) before they return.

## What Changes

- `hosts/codex/` holds the Codex host:
  - `bin/orchestrator.mjs` is a copy of the Claude Code launcher. Its npx fallback is pinned to the dependency version in `hosts/codex/package.json` instead of `.claude-plugin/plugin.json`.
  - `package.json` is private and pins `@autodidacticon/orchestrator` at the Claude Code plugin's version.
  - `config.toml` is the registration template: `[mcp_servers.orchestrator_operator]` with `command = "node"`, the launcher and `mcp` as args, `startup_timeout_sec = 30` and `tool_timeout_sec = 180`.
  - `README.md` documents the install: the TOML block, the `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms> -- node …/orchestrator.mjs mcp` alternative, verification with `codex mcp get`, skill links under `~/.codex/skills`, and the approval keys `codex exec` needs.
  - `skills/{import,run,review}/SKILL.md` are named `orchestrator-import`, `orchestrator-run` and `orchestrator-review`. They have no Workflow or subagent section and no Claude default model names. They read `AGENTS.md` for the test command, with `CLAUDE.md` as the fallback. The toolchain line always names the runner kind. A fresh run is started with `mode: "spawn"` unless `orchestrator.yaml` sets `runner.mode`, and a running daemon's mode is left alone. The approval gate of `codex exec` is stated.
- `.gitignore` ignores `hosts/codex/node_modules/`.
- The operator-mcp "Wait tool" wording names the host's tool-call timeout. The comment on `WAIT_CAP_MS` says the same; there is no behaviour change.
- Tests:
  - `test/host/codex-host.test.ts` parses the template and asserts `tool_timeout_sec >= ceil(WAIT_CAP_MS/1000)+30`. When `codex` is on PATH, it also has Codex read the template from a scratch `CODEX_HOME`.
  - The same test checks the launcher's three sources and the pin, and the skill edition's constraints.
  - `test/slice/operator-mcp.test.ts` asserts that the `wait` description quotes the cap in force.
  - `test/e2e/codex-operator.test.ts` (`ORCH_E2E_CODEX_OPERATOR=1`) has `codex exec` drive a spawn-mode run of scripted agents to `finished`.

## Capabilities

### Modified Capabilities
- `host-integration`: the "Per-host wrappers" and "Skills" requirements are modified, and a "Codex host" requirement is added.
- `operator-mcp`: the "Wait tool" wording.

## Impact

- New files only under `hosts/codex/`, plus tests. The Claude Code plugin is unchanged.
- Two skill editions must be kept in sync.
- Installation is a documented command until Codex's plugin and marketplace format is established.
