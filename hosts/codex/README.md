# Codex host

The orchestrator's operator session can be a Codex session. This directory holds what Codex
needs for it: the dependency-free launcher `bin/orchestrator.mjs`, a private `package.json`
that pins the published `@autodidacticon/orchestrator` package at the version the Claude Code
plugin pins, the MCP registration template `config.toml`, and the `orchestrator-import`,
`orchestrator-run`, and `orchestrator-review` skills under `skills/`.

Codex has no established plugin manifest yet, so installation is two documented steps rather
than a one-click plugin.

## 1. Register the operator MCP server

The launcher resolves the package from a checkout (this directory's grandparent), then from
`hosts/codex/node_modules` (`npm install` here), then from `npx` at the pinned version, so
nothing needs to be on PATH but `node` (22.13 or newer).

Primary form: append the block in `config.toml` to `~/.codex/config.toml` (or a project's
`.codex/config.toml`), with `<hosts/codex>` replaced by the absolute path of this directory:

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
session monitors. The test command is looked up in
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
