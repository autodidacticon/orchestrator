## MODIFIED Requirements

### Requirement: OpenCode host
`hosts/opencode/` SHALL let an OpenCode session be the operator. It SHALL ship `bin/orchestrator.mjs`, the third copy of the launcher of "Plugin launcher", whose npx fallback is pinned to the version of the published package in `hosts/opencode/package.json`. `hosts/opencode/package.json` SHALL be private, named for the host and not for the package, and SHALL have the published package as its only dependency, pinned to the exact version the Claude Code plugin pins. `hosts/opencode/node_modules` SHALL be ignored by git.

`hosts/opencode/opencode.json` SHALL be the registration snippet. It SHALL declare `mcp.orchestrator_operator` with `type: "local"`, `command` set to `node`, the launcher, and `mcp`, and a per-server `timeout` in milliseconds above `WAIT_CAP_MS + 30000` (180000), because OpenCode cuts an MCP call at 60 seconds by default and the per-server `timeout` is the only cap opencode 1.18.30 honours. It SHALL have no `mcp.timeout` block, which 1.18.30 drops with a compatibility diagnostic. OpenCode names the tools `<id>_<tool>`, so they are `orchestrator_operator_<tool>`.

`hosts/opencode/README.md` SHALL document merging the snippet into `~/.config/opencode/opencode.json` or a project's `opencode.json` as the primary install, and `opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=<ms below 60000> -- node <hosts/opencode>/bin/orchestrator.mjs mcp` as the alternative, which cannot set `timeout`. It SHALL document verification with `opencode mcp list`, the skills install, the plugin, the start-mode rule, and that the attachment ends when OpenCode closes the server's stdio. It SHALL have a pull-mode section documenting `orchestrator-work --runner opencode --workers 2`, run from a checkout as `node <hosts/codex>/bin/work.mjs --runner opencode`, and SHALL say that a `startupContended` start under `dataDir: shared` is released for relaunch.

`hosts/opencode/skills/` SHALL hold `import`, `run`, and `review` skills named `orchestrator-import`, `orchestrator-run`, and `orchestrator-review`. Each SHALL be the Codex host's edition with the tool prefix `mcp__orchestrator_operator__` replaced by `orchestrator_operator_`, the host name changed, and only these blocks rewritten: the operator tools' permissions in place of Codex approvals (under `opencode run` a tool whose permission is `ask` is rejected automatically, and the remedy is `"orchestrator_operator_*": "allow"`), the OpenCode form of the tracker connectors (`mcp.linear` and `mcp.atlassian` entries whose tools are `linear_<tool>` and `atlassian_<tool>`), the per-server `timeout` in place of `tool_timeout_sec`, the toolchain line and kind lists naming `opencode` (its permission and commit policy), and the pull-mode offer. A host test SHALL hold the two editions to exactly those differences. Because an OpenCode session has no session workers, the skills SHALL call `start` with `mode: "spawn"` when no daemon is running and `orchestrator.yaml` sets no `runner.mode`, and without `mode` otherwise. When the mode in force is `pull` or `mixed` they SHALL say so and SHALL offer `spawn` unless another session holds launches of the run. When the run holds `opencode` launches they SHALL also offer the work loop that `modeNote` names (`orchestrator-work --runner opencode`, "Work loop by runner kind"), started from a shell.

`hosts/opencode/plugins/orchestrator.js` SHALL be the session plugin, installed by linking it into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`). It SHALL export exactly one function, since OpenCode calls every exported function as a plugin. It SHALL find `hooks/session-start.mjs` beside its own real path, or under `ORCH_OPENCODE_HOST` for a copied install. On `session.created` for a session without a `parentID` it SHALL run the script once with `node` and a ten-second timeout. On that session's first `chat.message` it SHALL append the script's line to the user's existing text part, SHALL never push a new part (OpenCode refuses a part without ids), and SHALL leave the message untouched when the script printed nothing. It SHALL show the line through `client.tui.showToast` and SHALL ignore a client without a TUI. It SHALL NOT use `experimental.chat.system.transform`. `hosts/opencode/hooks/` SHALL hold byte copies of the Claude Code plugin's `session-start.mjs` and `session-end.mjs`; nothing runs the end script, since OpenCode has no session end event and the operator server ends its own attachment when its stdio closes. Worker launches pass `--pure` by default, through the `{pure}` slot that `runner.opencode.pure` (default `true`) fills, and then never load the plugin. With `runner.opencode.pure: false` a worker launch omits `--pure` and loads every installed plugin, this one included, so a worker started while a run needs attention gets the start line appended to its brief message. `hosts/opencode/README.md` SHALL say both.

#### Scenario: OpenCode registration verified
- **WHEN** `OPENCODE_CONFIG` names the snippet with `<hosts/opencode>` filled in and `opencode mcp list` is run
- **THEN** it reports `orchestrator_operator` as `connected` with the launcher command

#### Scenario: operator server answers in an OpenCode session
- **WHEN** `opencode run` runs with the snippet as its config and is asked to call `orchestrator_operator_start` with `mode: "spawn"`
- **THEN** its `tool_use` event names `orchestrator_operator_start`, completed, and the result reports `mode: "spawn"`

#### Scenario: Skill editions held in step
- **WHEN** the Codex edition of a skill is changed in a block the OpenCode edition shares
- **THEN** the host test fails until the OpenCode edition carries the same change

#### Scenario: Notice appended once
- **WHEN** the plugin sees `session.created` and then two `chat.message` calls for that session while a run needs attention
- **THEN** the first message's text part ends with the start line, the second is untouched, and one toast shows the line

#### Scenario: Nothing needs attention
- **WHEN** the plugin runs with an `ORCH_HOME` that holds no run
- **THEN** the user's message part is unchanged and no toast is shown

#### Scenario: Worker launch not pure
- **WHEN** `runner.opencode.pure` is `false` and an opencode worker launch is composed
- **THEN** the command carries no `--pure`, so a globally installed session plugin loads into the worker
