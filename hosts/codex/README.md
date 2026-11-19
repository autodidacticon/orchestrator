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
(the first start may fetch the package through npx), and `tool_timeout_sec` 180. The skills
are installed as `orchestrator-codex:orchestrator-import`, `orchestrator-codex:orchestrator-run`,
and `orchestrator-codex:orchestrator-review`.

Codex gives a plugin's server only the variables its `env_vars` lists, plus its own baseline:
`HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR` and `USER` (and
`__CF_USER_TEXT_ENCODING` on macOS). The plugin forwards
`PATH`, `HOME`, `ORCH_HOME`, `ORCH_WAIT_CAP_MS`, `ORCH_REPO`, `ORCH_URL`, `CODEX_HOME` and
`CODEX_API_KEY`. The server starts the daemon with its own environment, and a spawn-mode daemon
passes that environment to the codex workers it spawns. So:

- `ORCH_URL` points the server at a remote daemon.
- `CODEX_HOME` keeps the workers on the session's Codex home. Without it they would use
  `~/.codex` and its `auth.json`, whatever `CODEX_HOME` the session has.
- `CODEX_API_KEY` is the key variable `codex exec` reads, for a user who authenticates by key
  rather than with `auth.json`.
- `OPENAI_API_KEY` is not forwarded. `codex exec` 0.164 ignores it: in a Codex home without
  `auth.json`, a run with only `OPENAI_API_KEY` set fails to authenticate, as with no key at all.

Any other variable your workers need, such as a model provider's key named in `config.toml`,
does not reach a daemon started from the plugin. For spawn mode, start that daemon outside Codex
(`npx --package=@autodidacticon/orchestrator orchestrator-ctl start` from a shell in the
repository, with the same `ORCH_HOME`), and the plugin's server uses the running daemon.
The probe behind these facts is `test/fixtures/codex/plugin-probe/` (see `results.json`).

The server runs in the plugin root, not in your project, and Codex tells an MCP server
neither the session's project (it advertises no MCP roots) nor its directory. So every
operator tool takes a `repo` argument, the project's absolute path, and the skills pass this
session's working directory as `repo` on every call. A call without `repo`, before any call
passed one, is refused with an error naming the argument. Called directly, pass it yourself.

The plugin's `hooks/hooks.json` runs the two session hooks (section 3) through
`${PLUGIN_ROOT}`. A probe with codex-cli 0.164 showed:

- Codex reads the plugin's `hooks/hooks.json` and substitutes `${PLUGIN_ROOT}` with the installed
  plugin root before the shell runs. The hook also gets `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` and
  `PLUGIN_DATA` in its environment, plus all of codex's own environment. It runs in the
  session's working directory.
- The codex process is the parent of each hook and of the operator server, which the session
  end hook's ancestry match needs.
- The SessionStart line reaches the session's context as hook context. `codex exec` does not
  print it, but the session's rollout under `$CODEX_HOME/sessions` records it.
- A SessionEnd hook gets one second unless it declares a timeout, and Codex caps a declared
  one at three seconds. The plugin declares three.
- Codex runs a plugin's hooks only once they are trusted. Review them in an interactive session
  (`/hooks`). The review records each hook in `config.toml` as
  `[hooks.state."orchestrator-codex@orchestrator:hooks/hooks.json:session_start:0:0"]` (and
  `session_end:0:0`) with `trusted_hash` and `trusted_content_hash`. The content hash was the
  same for every hook of the file, so a plugin update that changes `hooks/hooks.json` most
  likely needs a new review (not probed). Under `codex exec`, untrusted hooks are skipped with
  no message unless you pass `--dangerously-bypass-hook-trust`.

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

The skills differ from the Claude Code plugin's. A Codex session can start subagents
("Workers in a Codex session"), but no orchestrator work loop uses them yet, so there is no
work workflow and no `work` skill. A fresh run is started with `mode: "spawn"` (unless
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
- A loop stops when the run is finished or stalled, when nothing is claimable and nothing is
  being prepared for codex (`status.preparingByKind.codex` is 0) while
  a question or review waits on a human, or after `--idle-exit-ms` (default 120000) with
  nothing claimable for codex.
- The daemon is found by `--url`, `ORCH_URL`, or the run directory of `--repo` (default: the
  current directory).
- Ctrl-C terminates the codex processes and releases their launches with `keep`.
- Progress lines go to stderr. A summary JSON goes to stdout on exit. Each launch's codex
  output is in `<worktree>/.orchestrator/codex-work.log`.
- When codex starts, the loop prints the session's thread id once per launch:
  `cx-1: T3 codex session <thread_id> (kept: codex exec resume <thread_id>)`, or
  `(ephemeral: not kept)` under the default `runner.codex.ephemeral: true`.

The shell is the primary path because nobody has verified that a background process started
from a Codex session outlives the turn. A Codex session can start subagents (next section),
but no orchestrator work loop uses them yet; the OpenSpec change `codex-visible-workers` holds
the design for one.

## Workers in a Codex session

What a Codex user can see of the loop's workers. Every fact below was shown with codex-cli
0.170.0 on 2026-11-18 (`codex --version` prints `codex-cli 0.170.0`; the task that asked for
it named 0.169.0, which this machine had since updated from). Each probe was a one-line prompt
in a scratch git repository `<dir>` with `-s read-only`; the ids are the probes' own.

**A worker's session is kept only without `--ephemeral`.** The loop runs the Codex runner's
command, which passes `--ephemeral` while `runner.codex.ephemeral` is `true` (the default).

```sh
codex exec --json -s read-only -C <dir> 'Call the spawn_agent tool once to start a subagent whose task is: reply with the word pong. Wait for it with wait_agent, then reply with its answer only.' < /dev/null
# {"type":"thread.started","thread_id":"01a1f189-1873-7350-8677-4072d2c7582e"}   <- the first event
find ~/.codex/sessions -name '*01a1f189-1873*'
# ~/.codex/sessions/2026/11/18/rollout-2026-11-18T20-00-56-01a1f189-1873-7350-8677-4072d2c7582e.jsonl
head -1 <that rollout>    # session_meta: "cwd":"<dir>", "source":"exec", "originator":"codex_exec"
sqlite3 ~/.codex/state_5.sqlite "select id, source, git_branch, title, name from threads where id='01a1f189-1873-7350-8677-4072d2c7582e'"
# 01a1f189-1873-...|exec|main|Call the spawn_agent tool once to start ...|        (name is empty)
codex exec --json --ephemeral -s read-only -C <dir> 'Reply with the single word ok.' < /dev/null
# {"type":"thread.started","thread_id":"01a1f18c-d64e-71a1-a4c3-5aede570bda8"}
find ~/.codex/sessions -name '*01a1f18c-d64e*' | wc -l                                                         # 0
sqlite3 ~/.codex/state_5.sqlite "select count(*) from threads where id='01a1f18c-d64e-71a1-a4c3-5aede570bda8'"  # 0
```

**`codex resume` lists exec sessions only with `--include-non-interactive`.** The picker is a
TUI; it was read through a pty in `<dir>`, which then held three kept exec sessions, one
interactive session and the ephemeral run:

```sh
codex resume                              # 1 / 1: only the interactive session
codex resume --include-non-interactive    # 1 / 4: the interactive session and the three exec
                                          # sessions, each titled by its first prompt
                                          # ("● Use the pingworker skill."); no ephemeral run
codex resume --help                       # --all: "disables cwd filtering and shows CWD column"
```

The picker filters by the cwd it is started in, so a worker's session shows when the picker is
started in the launch's worktree (the worker ran with `-C <worktree>`), or with `--all`, which
still lists a session after its directory is gone: in a scratch `CODEX_HOME` whose probe
directory had been moved away, `codex resume --all --include-non-interactive`, started
elsewhere, showed all five of its exec sessions (`1 / 5`) and no subagent.

A worker's title is its first prompt, which for the loop is its preamble on stdin ("You are a
Codex worker started by the orchestrator's Codex work loop (worker cx-1). ..."). A prompt given
on stdin is the title as well:

```sh
codex exec --json -s read-only -C <dir> - < prompt.md   # prompt.md: "You are a Codex worker started by the orchestrator probe (worker cx-1).\nReply with the single word ok."
sqlite3 $CODEX_HOME/state_5.sqlite "select source, title from threads where id='01a1f1a2-5346-78b0-b3ac-504997a3159a'"
# exec|You are a Codex worker started by the orchestrator probe (worker cx-1).
#      Reply with the single word ok.
```

**A session has no name of its own; it is found by its cwd or its thread id.** `codex exec
--help` has no option that names a session (`--thread-source` only classifies it). Codex knows
session names (`codex archive --help`: "Session id (UUID) or session name"), but an exec
session's `name` in `threads` is empty. `codex exec resume <thread_id>` resumes one by id
(`codex exec resume --help`: "Conversation/session id (UUID) or thread name").

**`codex agents` lists exec sessions.** Read through a pty (`codex agents --no-daemon`, after
"Continue without trusting" at its hook review): the "Agent command center" groups sessions by
project cwd. After all the probes it showed `<dir> 3`: the interactive session (○ "Use
pingworker skill") and the two exec sessions of that day (● "Use the pingworker skill.", ● "Call
the spawn_agent tool once ..."), each "Inactive". It showed neither the ephemeral run nor any
subagent. It is a recent view, not the whole history: an exec session from the day before in
the same `<dir>` was not in it.

**A session can start subagents, and a plugin's skill can ask it to.** The collaboration tools
are `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents` and
`interrupt_agent`. In the first probe above:

```sh
grep -o '"multi_agent_version":"[^"]*"' <its rollout>     # "v2"
sqlite3 ~/.codex/state_5.sqlite "select * from thread_spawn_edges where parent_thread_id='01a1f189-1873-7350-8677-4072d2c7582e'"
# 01a1f189-1873-...|01a1f189-2b9f-7f90-a955-62af1b9fb0c8|open
sqlite3 ~/.codex/state_5.sqlite "select source, agent_nickname, agent_path from threads where id='01a1f189-2b9f-7f90-a955-62af1b9fb0c8'"
# {"subagent":{"thread_spawn":{"parent_thread_id":"01a1f189-1873-...","depth":1,...}}}|Volta|/root/pong_reply
```

- The child has its own rollout file and `threads` row, linked in `thread_spawn_edges`. It is
  not a row of its own in either resume picker (the four rows above include no child) nor in
  `codex agents` (`<dir> 3` above holds three subagents' parents and none of the three).
- The exec `--json` stream does not carry the spawn: it shows a `collab_tool_call` item with
  `"tool":"wait"` and empty `receiver_thread_ids`, then the agent's answer "pong".
- A skill asks for one as a prompt does. A plugin `pingplug` (`.codex-plugin/plugin.json` with
  `"skills": "./skills/"`, holding `skills/pingworker/SKILL.md`, which says to call
  `spawn_agent` once), installed in a scratch `CODEX_HOME` with `codex plugin marketplace add`
  and `codex plugin add pingplug@probe-market`: `codex exec ... 'Use the pingworker skill.'`
  read `.../plugins/cache/probe-market/pingplug/0.0.1/skills/pingworker/SKILL.md`, answered
  "pong", and its thread has a `thread_spawn_edges` row. A repository skill
  (`.agents/skills/pingworker/SKILL.md`) does the same.
- Subagents are visible in the interactive TUI. `codex -s read-only -C <dir> 'Use the
  pingworker skill.'` (read through a pty, the folder trusted by a `-c projects=...` override)
  showed "• Started `/root/pingworker`", "• Waiting for agents", "• Completed
  `/root/pingworker`" and the footer hint "← agents"; the child is a `threads` row whose
  `source` is `{subagent: ...}`.

**What the feature flags change.** `codex features list` shows `multi_agent` deprecated and
`true`, `multi_agent_v2` stable and `false`, and `subagent_thread_environments` and
`runtime_agent_instances` under development and `false`. Those flags do not decide whether a
session has the tools; `agents.enabled` does. Each run below asked for one subagent, and to
answer "none" when it had no `spawn_agent`:

```sh
codex exec ... --disable multi_agent "<prompt>"     # "pong"; spawn_agent and the five others; "multi_agent_version":"v2"
codex exec ... --enable multi_agent_v2 "<prompt>"   # "pong"; the same six tools; "v2"
codex exec ... -c agents.enabled=false "<prompt>"   # "none"; no collaboration tool; "multi_agent_version":"disabled"
```

Not shown: whether a subagent can call the orchestrator's MCP tools, and whether it can work in
a cwd other than its parent's (`subagent_thread_environments` is off). The design in
`openspec/changes/codex-visible-workers` lists them as open questions.

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
