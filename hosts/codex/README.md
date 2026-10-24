# Codex host

The orchestrator's operator session can be a Codex session. This directory holds what Codex
needs for it: the dependency-free launcher `bin/orchestrator.mjs`, a private `package.json`
that pins the published `@autodidacticon/orchestrator` package at the version the Claude Code
plugin pins, the `orchestrator-import`, `orchestrator-run`, and `orchestrator-review` skills
under `skills/`, and two ways to install them: the Codex plugin `orchestrator-codex`
(`.codex-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`), or the manual registration
template `config.toml`.

## Install as a Codex plugin

The repository root's `.agents/plugins/marketplace.json` lists the plugin `orchestrator-codex`
from `./hosts/codex`. Add the repository as a marketplace and install the plugin:

```sh
codex plugin marketplace add autodidacticon/orchestrator
codex plugin add orchestrator-codex@orchestrator
```

A local checkout works as the marketplace too (`codex plugin marketplace add
/path/to/orchestrator`). `codex plugin list` shows `orchestrator-codex@orchestrator` as
installed, and `codex mcp get orchestrator_operator` shows the operator server it declares:
command `node` with args `./bin/orchestrator.mjs mcp`, its `cwd` the installed plugin root
(`~/.codex/plugins/cache/orchestrator/orchestrator-codex/<version>`), `startup_timeout_sec` 60
(the first start may fetch the package through npx), and `tool_timeout_sec` 180. The server
gets `PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, and `ORCH_REPO` from Codex's
environment. The skills are installed as `orchestrator-codex:orchestrator-import`,
`orchestrator-codex:orchestrator-run`, and `orchestrator-codex:orchestrator-review`.

The server runs in the plugin root, not in your project, and Codex tells an MCP server
neither the session's project (it advertises no MCP roots) nor its directory. So every
operator tool takes a `repo` argument, the project's absolute path, and the skills pass this
session's working directory as `repo` on every call. A call without `repo`, before any call
passed one, is refused with an error naming the argument. Called directly, pass it yourself.

The plugin's `hooks/hooks.json` runs the two session hooks (section 3) through
`${PLUGIN_ROOT}`. Codex runs a plugin's hooks only after you review and trust them in an
interactive session.

Under `codex exec` the operator tools need approvals granted in advance, as for the manual
install ("Approvals" below), but for a plugin's server they go under the plugin's key in
`config.toml`:

```toml
approval_policy = "never"

[plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator]
default_tools_approval_mode = "approve"

[plugins."orchestrator-codex@orchestrator".mcp_servers.orchestrator_operator.tools.start]
approval_mode = "approve"
# ... one such table for each operator tool the session calls
```

If you added this repository as a Codex marketplace before it had
`.agents/plugins/marketplace.json`, Codex installed the Claude Code plugin as
`orchestrator@orchestrator`. Its operator server cannot start under Codex (its args use
`${CLAUDE_PLUGIN_ROOT}`, which Codex does not expand) and its skills are the Claude Code
edition. Remove it before installing this one:

```sh
codex plugin remove orchestrator@orchestrator
```

Remove the plugin itself with `codex plugin remove orchestrator-codex@orchestrator`. Use
either the plugin or the manual install below, not both: both declare `orchestrator_operator`.

## Manual install (alternative)

The two steps below register the server and the skills by hand. A manually registered server
started from your project's directory finds the repository by itself; the skills still pass
`repo`.

## 1. Register the operator MCP server

The launcher resolves the package from a checkout (this directory's grandparent), then from
`hosts/codex/node_modules` (`npm install` here), then from `npx` at the pinned version, so
nothing needs to be on PATH but `node` (22.13 or newer).

Primary manual form: append the block in `config.toml` to `~/.codex/config.toml` (or a
project's `.codex/config.toml`), with `<hosts/codex>` replaced by the absolute path of this
directory:

```toml
[mcp_servers.orchestrator_operator]
command = "node"
args = ["/path/to/orchestrator/hosts/codex/bin/orchestrator.mjs", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 180
```

The id is `orchestrator_operator`, with an underscore; the tools are then
`mcp__orchestrator_operator__<tool>`. `tool_timeout_sec` must be at least the operator
server's `wait` cap in seconds plus 30. The cap is 90 seconds, and `launch_block` waits up to
it as well, so Codex's default of 60 seconds would abandon those calls before they return.

Alternative: `codex mcp add` writes the entry for you but cannot set `tool_timeout_sec`, so
lower the server's cap below Codex's default instead. `ORCH_WAIT_CAP_MS` lowers both the cap
and the `wait` default:

```sh
codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=30000 -- node /path/to/orchestrator/hosts/codex/bin/orchestrator.mjs mcp
```

Verify either form with:

```sh
codex mcp get orchestrator_operator
```

It lists the server as enabled, transport `stdio`, command `node`, and the launcher and `mcp`
as its args (and, for the `codex mcp add` form, `ORCH_WAIT_CAP_MS` under env). Remove it with
`codex mcp remove orchestrator_operator`.

## 2. Install the skills

Codex discovers skills in `~/.codex/skills/<name>/SKILL.md` (under `CODEX_HOME`) and in a
repository's `.agents/skills/<name>/SKILL.md`. Link or copy each skill under its name; Codex
0.163 follows a symlinked skill directory in both places.

```sh
ln -s /path/to/orchestrator/hosts/codex/skills/import ~/.codex/skills/orchestrator-import
ln -s /path/to/orchestrator/hosts/codex/skills/run ~/.codex/skills/orchestrator-run
ln -s /path/to/orchestrator/hosts/codex/skills/review ~/.codex/skills/orchestrator-review
```

A target repository that vendors the skills can put them in its own `.agents/skills/` instead,
so that they are found whenever Codex works in that repository.

`[[skills.config]]` entries with a `path` do not add a skill. They select a skill Codex has
already discovered, for example `enabled = false` to hide one, and a `path` outside the
discovery directories loads nothing.

The skills differ from the Claude Code plugin's. A Codex session has no subagents, so there
is no work workflow and no `work` skill. A fresh run is started with `mode: "spawn"` (unless
`orchestrator.yaml` sets `runner.mode`), and the daemon runs the agents headless while the
session monitors. To work a `pull` or `mixed` run, start the Codex work loop from a shell
(section 4). The test command is looked up in
`AGENTS.md`, with `CLAUDE.md` as the fallback when a repository has no `AGENTS.md`. The
toolchain line always names the runner kind.

## 3. Session hooks (optional)

`config.toml` also holds `[[hooks.SessionStart]]` and `[[hooks.SessionEnd]]` blocks that run
`hooks/session-start.mjs` and `hooks/session-end.mjs` with `node`. These are the Claude Code
plugin's scripts, copied byte for byte. They need `features.hooks = true`, which is on by
default in Codex 0.163; the template's `[features]` table sets it. If your config already has
a `[features]` table, add `hooks = true` to it instead.

- SessionStart (`startup|resume|clear`) prints one line naming the runs under `ORCH_HOME` that
  need a session or a human. Codex adds the line to the session's context.
- SessionEnd posts the hook's process ancestry to every alive daemon. The codex process is
  the parent of both the hook and the operator MCP server, so the daemon ends that server's
  attachment and releases its claimed launches with keep. Codex's SessionEnd input always has
  `reason` `"other"`, and that is the reason recorded.

Without the hooks, nothing is lost but the startup notice: the operator server ends its own
attachment when Codex closes its stdio, and the daemon ends any attachment whose process is
dead.

Codex runs a configured hook only after it is trusted. The trust is recorded under
`hooks.state` in `config.toml` after you review the hook in an interactive session. Under
`codex exec`, untrusted hooks do not run unless you pass `--dangerously-bypass-hook-trust`.

## 4. Codex work loop (pull mode)

`bin/work.mjs` is the Codex host's pull-mode worker. It is also the package executable
`orchestrator-work`. Start it from a shell in the target repository while the run is in
`pull` or `mixed` mode:

```sh
node /path/to/orchestrator/hosts/codex/bin/work.mjs --workers 2 --run-tag cx --capacity 4
# or, from an install of the package: npx orchestrator-work --workers 2 --run-tag cx
```

- Each of the N loops claims launches prepared for `codex` (`workerId cx-<n>`). It runs
  `codex exec` in the claimed worktree with the command a spawned launch gets: the same
  orchestrator MCP registration, approvals, sandbox and model. On stdin it passes a short
  preamble followed by the brief. When codex exits, the loop posts the token usage and then
  claims again.
- A codex that fails to start is released with `keep`. After `--max-failures` (default 3)
  launches in a row that ended without codex running or reporting, a loop stops.
- A loop stops when the run is finished or stalled, when nothing is claimable for codex while
  a question or review waits on a human, or after `--idle-exit-ms` (default 120000) with
  nothing claimable for codex.
- The daemon is found by `--url`, `ORCH_URL`, or the run directory of `--repo` (default: the
  current directory).
- Ctrl-C terminates the codex processes and releases their launches with `keep`.
- Progress lines go to stderr. A summary JSON goes to stdout on exit. Each launch's codex
  output is in `<worktree>/.orchestrator/codex-work.log`.

The shell is the primary path because nobody has verified that a background process started
from a Codex session outlives the turn. Codex's `features.multi_agent` subagents are an
unverified alternative.

## Approvals

In an interactive Codex session, Codex asks before each operator tool call. Under
`codex exec`, approvals cannot be given, and every operator tool call is refused unless they
are granted in advance:

```toml
approval_policy = "never"

[mcp_servers.orchestrator_operator]
default_tools_approval_mode = "approve"

[mcp_servers.orchestrator_operator.tools.wait]
approval_mode = "approve"
# ... one such table for each operator tool the session calls
```

Under `approval_policy = "never"` the Codex runner's probes found that a tool call needs both
the default and the per-tool `approve`. The opt-in end to end
`test/e2e/codex-operator.test.ts` (`ORCH_E2E_CODEX_OPERATOR=1`) passes these keys as `-c`
overrides, for every operator tool, and drives a spawn-mode run to `finished`.
