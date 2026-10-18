## Why

A Codex operator session still releases its claims with keep when Codex closes the operator server's stdio, but it loses the SessionStart notice about runs that need attention, and the host's reason on session end. The Codex edition of the skills is also not found when the operator works in a target repository unless it is installed where Codex looks.

## What Changes

- `hosts/codex/hooks/session-start.mjs` and `session-end.mjs` are byte-for-byte copies of the Claude Code plugin's scripts. They are copies rather than a shared `hosts/common/` because a host directory must work when copied alone (the decision taken for the launcher). A test pins the copies to the originals.
- `hosts/codex/config.toml` adds `[features] hooks = true`, a `[[hooks.SessionStart]]` group (matcher `startup|resume|clear`, timeout 10) and a `[[hooks.SessionEnd]]` group. Both run `node "<hosts/codex>/hooks/<script>"`. The template says that Codex runs a hook only once it is trusted.
- `hosts/codex/README.md` gains a session hooks section covering `features.hooks`, trust and `--dangerously-bypass-hook-trust`, and Codex's reason `"other"`. It corrects skill discovery: `~/.codex/skills/<name>` (a symlink works) or `.agents/skills/<name>` in a target repository. `[[skills.config]]` `path` entries only select an already-discovered skill.
- Specs: host-integration "Session start hook" and "Session end hook" become host-neutral, each with a Codex scenario. "Skills" names where Codex finds its edition. operator-control "Session attachments" gains a Codex ancestry scenario.

## Probe results (Codex 0.163.0, scratch `CODEX_HOME`)

- `--strict-config` accepts the `[[hooks.<Event>]]` / `[[hooks.<Event>.hooks]]` form with `type`, `command`, `timeout`, and `matcher`. `features.hooks` is stable and on by default.
- SessionEnd input is `{ session_id, transcript_path, cwd, hook_event_name: "SessionEnd", reason: "other" }`. The schema makes `reason` the constant `"other"`. SessionStart input carries `source` (`startup|resume|clear|compact|fork`).
- Under `codex exec`, SessionStart's plain stdout reached the model's context.
- The hook's parent process is the `codex` process, and so is a stdio MCP server's. The operator server's chain (server, launcher, codex) therefore shares the codex pid with the hook's ancestry. The ancestry match works, so the drawback named in the brief does not arise for `codex exec` and `codex debug prompt-input`. An interactive session attached to the shared app-server daemon was not probed.
- Without `--dangerously-bypass-hook-trust`, untrusted hooks did not run.
- A `[[skills.config]]` `path` to `hosts/codex/skills/run/SKILL.md` or its directory loaded nothing. A copy or a symlink under `CODEX_HOME/skills/` or a repository's `.agents/skills/` did load, and `enabled = false` on a discovered skill's path hid it.

## Capabilities

### Modified Capabilities
- `host-integration`: "Session start hook", "Session end hook", "Skills" (built on the unarchived `codex-host` change's text, so archive that change first).
- `operator-control`: "Session attachments" (a scenario only).

## Impact

- New files under `hosts/codex/hooks/`; `hosts/codex/config.toml` and `README.md` edited; tests in `test/host/codex-host.test.ts`. No daemon change.
