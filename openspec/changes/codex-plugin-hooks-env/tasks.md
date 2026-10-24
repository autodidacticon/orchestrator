## 1. Probe

- [x] 1.1 Write test/fixtures/codex/plugin-probe/probe.mjs: a recording plugin installed from a local marketplace into a scratch `CODEX_HOME`, run by codex-cli 0.164.0 with a minimal environment
- [x] 1.2 Record whether hooks.json is read, whether `${PLUGIN_ROOT}` is substituted, what trust needs (untrusted, `--dangerously-bypass-hook-trust`, `hooks.state` written as the TUI review writes it), and each hook's ancestry, in results.json
- [x] 1.3 Record the environment of the plugin's MCP server and which variables `codex exec` authenticates with

## 2. Plugin files

- [x] 2.1 Add `ORCH_URL`, `CODEX_HOME` and `CODEX_API_KEY` to `env_vars` in hosts/codex/.mcp.json
- [x] 2.2 Declare `timeout: 3` on the SessionEnd hook in hosts/codex/hooks/hooks.json

## 3. Tests

- [x] 3.1 Pin the `env_vars` list and the hooks in the plugin host test
- [x] 3.2 Extend the gated `ORCH_E2E_CODEX_HOST` plugin case: a run needing attention, `codex exec --dangerously-bypass-hook-trust`, and the SessionStart line in the rollout
- [x] 3.3 `npm test` green; the gated case passes with `ORCH_E2E_CODEX_HOST=1`; `openspec validate codex-plugin-hooks-env --strict` passes

## 4. Docs

- [x] 4.1 hosts/codex/README.md: the probe's findings and why each forwarded variable is there
- [x] 4.2 test/fixtures/codex/README.md: the plugin probe entry
