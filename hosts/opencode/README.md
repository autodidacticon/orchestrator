# OpenCode host

The orchestrator's operator session can be an OpenCode session. This directory holds what
OpenCode needs for it: the dependency-free launcher `bin/orchestrator.mjs`, a private
`package.json` that pins the published `@autodidacticon/orchestrator` package at the version
the Claude Code plugin pins, the MCP registration snippet `opencode.json`, the
`orchestrator-import`, `orchestrator-run`, and `orchestrator-review` skills under `skills/`,
and the session plugin `plugins/orchestrator.js` with the hook scripts it runs under `hooks/`.

Written against opencode 1.18.30. Installation is three documented steps.

## 1. Register the operator MCP server

The launcher resolves the package from a checkout (this directory's grandparent), then from
`hosts/opencode/node_modules` (`npm install` here), then from `npx` at the pinned version, so
nothing needs to be on PATH but `node` (22.13 or newer).

Primary form: merge the `mcp` block of `opencode.json` into `~/.config/opencode/opencode.json`
(or a project's `opencode.json`), with `<hosts/opencode>` replaced by the absolute path of this
directory:

```json
{
  "mcp": {
    "orchestrator_operator": {
      "type": "local",
      "command": ["node", "/path/to/orchestrator/hosts/opencode/bin/orchestrator.mjs", "mcp"],
      "timeout": 180000
    }
  }
}
```

The id is `orchestrator_operator`, with an underscore; OpenCode names the tools
`<id>_<tool>`, so they are `orchestrator_operator_start`, `orchestrator_operator_wait`, and so
on. `timeout` is in milliseconds and must be at least the operator server's `wait` cap plus
30 seconds. The cap is 90 seconds, and `launch_block` waits up to it as well, so OpenCode's
default of 60 seconds would cut those calls off with `MCP error -32001: Request timed out`.
The per-server `timeout` is the only cap opencode 1.18.30 honours: a global
`mcp.timeout.execution` block is dropped with a compatibility diagnostic, so do not add one.

Alternative: `opencode mcp add` writes the entry for you (to the global
`~/.config/opencode/opencode.jsonc`) but cannot set `timeout`, so lower the server's cap below
OpenCode's default instead. `ORCH_WAIT_CAP_MS` lowers both the cap and the `wait` default:

```sh
opencode mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=30000 -- node /path/to/orchestrator/hosts/opencode/bin/orchestrator.mjs mcp
```

It writes `type: "local"`, the command, and `environment: { "ORCH_WAIT_CAP_MS": "30000" }`.

Verify either form with:

```sh
opencode mcp list
```

It lists `orchestrator_operator` as `connected` with the launcher command. To check the
snippet without touching your config, point `OPENCODE_CONFIG` at a filled-in copy:
`OPENCODE_CONFIG=/tmp/orchestrator-opencode.json opencode mcp list`.

OpenCode runs MCP tools without asking unless a `permission` rule says otherwise. Under
`opencode run` a tool whose permission is `ask` is rejected automatically, so a config that
asks by default needs `"permission": { "orchestrator_operator_*": "allow" }`.

## 2. Install the skills

OpenCode discovers skills in `~/.agents/skills/<name>/SKILL.md` and `~/.claude/skills/<name>`
as well as a project's `.opencode/skills/<name>`; `opencode debug skill` lists what it found.
Link or copy each skill under its name:

```sh
ln -s /path/to/orchestrator/hosts/opencode/skills/import ~/.agents/skills/orchestrator-import
ln -s /path/to/orchestrator/hosts/opencode/skills/run ~/.agents/skills/orchestrator-run
ln -s /path/to/orchestrator/hosts/opencode/skills/review ~/.agents/skills/orchestrator-review
```

The Codex edition uses the same names and is found under a repository's `.agents/skills/`,
which OpenCode does not read, so the two editions do not collide in their documented places.
Do not link the Codex edition into `~/.agents/skills` as well, and do not install either
under `~/.claude/skills`, where Claude Code would find it beside the plugin's own skills.

This edition is the Codex edition with the tool names changed (`mcp__orchestrator_operator__`
to `orchestrator_operator_`) and the paragraphs that name the host rewritten: permissions
instead of approvals, `opencode.json` and `timeout` instead of `config.toml` and
`tool_timeout_sec`, the OpenCode form of the tracker tools (`linear_<tool>`), the toolchain
line of an `opencode` run, and the pull-mode offer. `test/host/opencode-host.test.ts` holds
the two editions to exactly those differences.

An OpenCode session has no subagents the orchestrator can drive, so there is no work workflow
and no `work` skill. A fresh run is started with `mode: "spawn"` (unless `orchestrator.yaml`
sets `runner.mode`), and the daemon runs the agents headless while the session monitors. A
running daemon is started without `mode`, which leaves its mode alone. A `pull` or `mixed`
run's `opencode` launches are worked by the work loop (below). The test command is looked up
in `AGENTS.md`, with `CLAUDE.md` as the fallback when a repository has no `AGENTS.md`. The
toolchain line always names the runner kind.

### Pull mode: the work loop

`hosts/codex/bin/work.mjs` (the package executable `orchestrator-work`) is the work loop of
both hosts. With `--runner opencode` it claims only `opencode` launches. Start it from a shell
in the repository:

```sh
node /path/to/orchestrator/hosts/codex/bin/work.mjs --runner opencode --workers 2 --run-tag oc --capacity <config.capacity>
```

From an install of a package release that has `--runner`:
`npx orchestrator-work --runner opencode --workers 2`. Release 0.4.0 has no `--runner`; it
rejects the flag. Each loop claims a launch (`runner: "opencode"`), writes
`.orchestrator/opencode.json`, and runs the same `opencode run ... < <prompt>` a spawned launch
gets, with the claim's per-launch config in `OPENCODE_CONFIG_CONTENT`. That config holds the
shim and the permission ruleset derived from the claim's `allowedTools`. The prompt is a short
preamble and then the brief. The shim reads the launch's identity from the environment
(`ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`), so no env file is written. After opencode exits,
the loop posts the usage summed over `step_finish` events as worker usage.

When `runner.opencode.dataDir` is `shared`, concurrent starts can find the database locked.
The loop names such a start `startupContended`, releases it with `keep: true` (the task goes
back to `unstarted` at no cost), backs off briefly, and claims again. It also staggers its
loops' first claims by 300 ms. `dataDir: launch` removes the lock, but each launch then needs
its own login. Like the Codex loop, starting it as a background command of an OpenCode
session is unverified.

## 3. Session plugin (optional)

`plugins/orchestrator.js` gives an OpenCode session the start notice the Claude Code and Codex
hosts get from their SessionStart hook. Link it into OpenCode's global plugin directory:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s /path/to/orchestrator/hosts/opencode/plugins/orchestrator.js ~/.config/opencode/plugins/orchestrator.js
```

The plugin finds `hooks/session-start.mjs` beside its own real path, so a symlink works as is.
For a copied plugin set `ORCH_OPENCODE_HOST` to the absolute path of this directory. A
project can use `.opencode/plugins/` instead.

- On `session.created` (a root session; a subagent's session is skipped) it runs
  `hooks/session-start.mjs` with `node`, once, with a ten-second timeout. That is the Claude
  Code plugin's script, copied byte for byte: one line naming the runs under `ORCH_HOME` that
  need a session or a human.
- On that session's first `chat.message` it appends the line to the user's text part, so the
  notice is saved with the message and stays in the session's context, and it shows the line
  as a toast in the TUI. When the script prints nothing, the message is left as it was. The
  notice therefore appears inside your first message in the transcript.
- `opencode run --pure` does not load plugins. The orchestrator's own opencode launches pass
  `--pure` by default (`runner.opencode.pure: true`), so the plugin only runs in operator
  sessions. With `runner.opencode.pure: false` worker launches drop `--pure` and load the
  project's `.opencode/plugins/` and, unless `runner.opencode.ignoreUserConfig` is `true`, every
  plugin installed under `~/.config/opencode/plugins/`, this one included: a worker started while
  a run needs attention gets the start line appended to its brief message. `ignoreUserConfig: true`
  (default `false`) points `XDG_CONFIG_HOME` at an empty directory, so a globally installed plugin
  does not load.

OpenCode has no session end event (`session.idle` fires after every turn), so nothing runs
`hooks/session-end.mjs`; the copy is kept so the three hosts ship the same scripts. Nothing is
lost: the operator server ends its own attachment when OpenCode closes its stdio, recorded
with reason `sessionEnded`, and the daemon releases that attachment's claimed launches with
`keep`. The daemon also ends any attachment whose process has died.

## Tests

`test/host/opencode-host.test.ts` checks the launcher, the pin, the snippet, the skill
editions, the hook copies, and the plugin's hooks with a fake client. Its checks that run the
installed `opencode` (registration through `opencode mcp list`, a headless `opencode run`
calling `orchestrator_operator_start`, and the plugin's notice reaching the model) are opt-in:

```sh
ORCH_E2E_OPENCODE_HOST=1 npx vitest run test/host/opencode-host.test.ts
```

They use `opencode/big-pickle` unless `ORCH_E2E_OPENCODE_MODEL` names another model, and a
scratch `XDG_CONFIG_HOME` so your own config and plugins stay out of the run.
