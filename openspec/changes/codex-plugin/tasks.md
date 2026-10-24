## 1. Operator server

- [x] 1.1 Every tool takes an optional `repo` (absolute, inside a git repository, kept as the real top level); the registration wrapper records it and strips it before the handler runs
- [x] 1.2 Resolution: the call's `repo`, the session's last `repo`, then `--repo`, `ORCH_REPO`, or the working directory's git top level; the refusal names the `repo` argument
- [x] 1.3 `start` and `stop` act on the resolved repository; the attachment is ended on every daemon it registered with
- [x] 1.4 The `repo` parameter description, the `start` description, and the usage text say all of this

## 2. Codex plugin

- [x] 2.1 `hosts/codex/.codex-plugin/plugin.json`, `hosts/codex/.mcp.json`, `hosts/codex/hooks/hooks.json`
- [x] 2.2 `.agents/plugins/marketplace.json` listing `orchestrator-codex` from `./hosts/codex`
- [x] 2.3 The Codex and OpenCode skills pass `repo` on every operator call
- [x] 2.4 `hosts/codex/README.md` leads with the plugin install, keeps the manual install, and covers removing `orchestrator@orchestrator`; the root README names the plugin

## 3. Tests

- [x] 3.1 Slice test: a server started outside any git repository refuses a call without `repo`, serves the repo a call passes (a subdirectory names its top level), reuses it for later calls, and never forwards it
- [x] 3.2 Host test: the plugin files parse, `.mcp.json` runs from `cwd: "."` with relative args and a tool timeout above the wait cap plus 30 s, the plugin version equals the package version, the skills pass `repo`, and the marketplace file lists the plugin
- [x] 3.3 Opt-in host test (`ORCH_E2E_CODEX_HOST=1`): codex installs the plugin from this checkout into a scratch `CODEX_HOME`, `codex mcp get` shows the plugin root as `cwd` and the timeouts, and `codex exec -C <repo>` calls `start` with `repo` and gets that repository back
