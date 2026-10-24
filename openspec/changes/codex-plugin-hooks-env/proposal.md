## Why

The CODEX-M5 review (2026-10-24) found that the Codex plugin's `hooks/hooks.json` had never been run by Codex. Its probe notes said "docs; not probed": nobody had checked that codex-cli 0.164 reads a plugin's hooks in this shape, substitutes `${PLUGIN_ROOT}` in a hook command, or runs the hook as a child of the codex process, which the session end hook's ancestry match needs. The host test checked only the file's text. The review also found that `.mcp.json` does not forward `ORCH_URL`, which the operator server reads to reach a remote daemon. Nobody had checked what environment Codex gives a plugin's MCP server, and so what a daemon started by that server passes to the codex workers it spawns.

A probe now answers these questions (test/fixtures/codex/plugin-probe/probe.mjs, results in results.json beside it). It installed a recording plugin from a local marketplace into a scratch `CODEX_HOME` and ran it with codex-cli 0.164.0:

- Codex reads the plugin's `hooks/hooks.json` in this shape. Its `hooks/list` lists each hook under the key `<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<index>`, with `${PLUGIN_ROOT}` already substituted in the command.
- Codex substitutes `${PLUGIN_ROOT}` before the shell runs: a single-quoted `'${PLUGIN_ROOT}'` reached the hook as the installed plugin root. The hook's environment also has `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA`, and all of codex's own environment.
- Under `codex exec`, an untrusted plugin hook does not run and nothing is reported. With `--dangerously-bypass-hook-trust` both hooks run. They also run without the flag once `config.toml` has `[hooks.state."<key>"]` with `trusted_hash` and `trusted_content_hash` equal to the hook's current hash. That is what the TUI's hook review writes, and the probe wrote it through the same app-server call (`config/batchWrite`).
- codex is the parent of each hook process and of the plugin's MCP server.
- The SessionStart hook's stdout reaches the context as a developer message of kind `hooks.additional_context`, recorded in the session's rollout. It is not printed to `codex exec`'s stdout or stderr. `codex debug prompt-input` runs only SessionEnd.
- A SessionEnd hook that declares no timeout gets one second. A declared five became three: Codex caps SessionEnd at three seconds.
- A plugin's MCP server gets only the variables in `env_vars` plus Codex's baseline (`HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`, and on macOS `__CF_USER_TEXT_ENCODING`). A variable set in codex's environment and absent from `env_vars` reached the hooks but not the server.
- `codex exec` authenticates from `$CODEX_HOME/auth.json` or from `CODEX_API_KEY`. It ignores `OPENAI_API_KEY`: in a `CODEX_HOME` without `auth.json`, a run with only `OPENAI_API_KEY` set failed with "Missing bearer or basic authentication", the same as with no key, while a fake `CODEX_API_KEY` was sent and rejected.

The operator server starts its daemon with its own environment (`src/runs/lifecycle.ts`), and the daemon passes that environment to its codex workers. Without `CODEX_HOME` in `env_vars`, the workers of a spawn-mode daemon started from the plugin use `~/.codex` whatever `CODEX_HOME` the session has, and without `CODEX_API_KEY` a user who authenticates by key has workers that cannot authenticate.

## What Changes

- `hosts/codex/.mcp.json` forwards `ORCH_URL`, `CODEX_HOME` and `CODEX_API_KEY` as well, after the existing five. `OPENAI_API_KEY` is not forwarded, because `codex exec` does not read it.
- `hosts/codex/hooks/hooks.json` keeps its shape and declares `timeout: 3` on the SessionEnd hook, the most Codex allows, instead of the one-second default.
- The gated `ORCH_E2E_CODEX_HOST` plugin case seeds a run needing attention in its `ORCH_HOME`, runs `codex exec` with `--dangerously-bypass-hook-trust` and without `--ephemeral`, and asserts that the session's rollout holds the SessionStart line as the hook's additional context.
- A host test pins the `env_vars` list and the SessionEnd timeout.
- hosts/codex/README.md records the probe's findings: trust, `${PLUGIN_ROOT}`, the hook and server environments, the SessionEnd cap, and why each forwarded variable is there.

## Capabilities

### Modified Capabilities
- `host-integration`: "Codex plugin hooks" (the SessionEnd timeout, the probed behaviour, and a gated scenario for the SessionStart line) and "Codex plugin MCP server" (the forwarded variables and why).

## Impact

- hosts/codex/.mcp.json, hosts/codex/hooks/hooks.json, hosts/codex/README.md
- test/host/codex-host.test.ts
- test/fixtures/codex/plugin-probe/ (probe.mjs, results.json), test/fixtures/codex/README.md
