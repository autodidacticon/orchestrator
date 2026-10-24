## MODIFIED Requirements

### Requirement: Codex plugin hooks
`hosts/codex/hooks/hooks.json` SHALL run `hooks/session-start.mjs` (matcher `startup|resume|clear`, ten-second timeout) on `SessionStart` and `hooks/session-end.mjs` (three-second timeout) on `SessionEnd`, each with `node` through `${PLUGIN_ROOT}`. This is the shape codex-cli 0.164 was probed running (test/fixtures/codex/plugin-probe): Codex reads the plugin's `hooks/hooks.json`, substitutes `${PLUGIN_ROOT}` with the installed plugin root before the shell runs, runs each hook as a child of the codex process, and adds the SessionStart hook's stdout to the session's context. A SessionEnd hook gets one second when it declares no timeout, and Codex caps a declared one at three seconds. Codex runs a plugin hook only when it is trusted, recorded in `config.toml` as `[hooks.state."<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<index>"]` with `trusted_hash` and `trusted_content_hash` by the interactive hook review, or under `--dangerously-bypass-hook-trust`. Under `codex exec` an untrusted hook is skipped without a message. The host README SHALL say so.

#### Scenario: Hooks parse
- **WHEN** the host tests read `hosts/codex/hooks/hooks.json`
- **THEN** it declares exactly the two hooks, each command naming its script under `${PLUGIN_ROOT}/hooks/`, SessionStart with timeout 10 and SessionEnd with timeout 3

#### Scenario: SessionStart line through the installed plugin
- **WHEN** `ORCH_E2E_CODEX_HOST=1`, the plugin is installed from the marketplace file into a scratch `CODEX_HOME` whose hooks are not trusted, `ORCH_HOME` holds a run whose daemon exited with two launches parked, and `codex exec --dangerously-bypass-hook-trust` runs without `--ephemeral`
- **THEN** the session's rollout holds one hook additional-context message: the SessionStart line naming that run, with its two parked launches

### Requirement: Codex plugin MCP server
`hosts/codex/.mcp.json` SHALL declare exactly one server, `orchestrator_operator`, with `command: "node"`, `args: ["./bin/orchestrator.mjs", "mcp"]`, and `cwd: "."`, because Codex resolves `cwd: "."` to the installed plugin root and expands no variable in `args`. It SHALL set `startup_timeout_sec: 60` (a first start may fetch through npx), `tool_timeout_sec` above `WAIT_CAP_MS / 1000 + 30` (180), and `env_vars` forwarding exactly `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, and `CODEX_API_KEY`, in that order. Codex gives a plugin's server only these and its own baseline (`HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`, and on macOS `__CF_USER_TEXT_ENCODING`), and the daemon the server starts inherits the server's environment and passes it to its codex workers. `ORCH_URL` lets the server reach a remote daemon. `CODEX_HOME` makes the workers of a spawn-mode daemon started from the plugin use the session's Codex home and its `auth.json`. `CODEX_API_KEY` is the key variable `codex exec` reads. `OPENAI_API_KEY` SHALL NOT be forwarded, because `codex exec` 0.164 ignores it. A host test SHALL pin the list.

#### Scenario: Server runs from the plugin root
- **WHEN** the plugin is installed and `codex mcp get orchestrator_operator --json` is run
- **THEN** its `cwd` is the installed plugin root, its args are `./bin/orchestrator.mjs` and `mcp`, `startup_timeout_sec` is 60, and `tool_timeout_sec` is 180

#### Scenario: Start through the plugin names the repository
- **WHEN** the installed plugin's launcher runs this checkout's build, its tools are pre-approved under the plugin's key, and `codex exec -C <throwaway repository>` is asked to call `start` with `repo` set to that repository
- **THEN** the `start` call's arguments carry the repository and its result has status 200 and names the repository

#### Scenario: Forwarded variables pinned
- **WHEN** the host tests read `hosts/codex/.mcp.json`
- **THEN** `env_vars` is `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME`, `CODEX_API_KEY`
