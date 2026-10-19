## Why

Without a host, OpenCode users operate runs only through the CLI. The skills cannot be reused verbatim: the tool names differ. The attachment release does not depend on hooks (stdio close covers it), so hooks only add the start notice and the reason.

## What Changes

1. `hosts/opencode/`: `bin/orchestrator.mjs` as a third launcher copy (pin from `hosts/opencode/package.json`; the host test asserts the three copies differ only in that line); `opencode.json` snippet declaring `mcp.orchestrator_operator { type: local, command: ["node", "<hosts/opencode>/bin/orchestrator.mjs", "mcp"], timeout: 180000 }` (above the 90 s wait cap with the Codex host's headroom; the per-server `timeout` is the only cap 1.18.30 honours, and the default is 60 s); README with the `opencode mcp add` alternative and the `ORCH_WAIT_CAP_MS` lowering as the Codex README does.
2. Skills: an OpenCode edition under `hosts/opencode/skills/{import,run,review}/SKILL.md`, generated from the Codex edition by a tool-name substitution (`mcp__orchestrator_operator__` to `orchestrator_operator_`) and an `opencode.json`/`AGENTS.md` toolchain line; the host test asserts the two editions differ only in those substitutions so they cannot drift. Install path `~/.agents/skills/orchestrator-<name>` (shared with Codex; one install serves both hosts when the tool-name lines are made neutral, which is the open question below).
3. Session hooks as a plugin `hosts/opencode/plugins/orchestrator.js` (decided 2026-10-19 from the Y2 probe, test/fixtures/opencode/events/Y2.jsonl and configs/inject-plugin.js: both `chat.message` and `experimental.chat.system.transform` put text in front of the model; the model repeated both markers verbatim). On `session.created` the plugin runs `session-start.mjs` once and caches its line; on the first `chat.message` of that session it appends the line to the user's existing text part (never pushes a new part: one without id/sessionID/messageID fails the run with "invalid user part before save"), so the notice is saved with the message and stays in context, as the Claude Code and Codex SessionStart stdout does; it also calls `client.tui.showToast` so the operator sees it. The system-prompt hook is not used (experimental, re-run every step). When the script prints nothing, the message is untouched. No session-end analog (document that the attachment ends on stdio close with reason `sessionEnded`). The plugin is installed by copying into `~/.config/opencode/plugins/`; `--pure` disables it, which only affects worker launches.
4. Start-mode handling as in the Codex skills: `start` with `mode: spawn` when no daemon runs and no `runner.mode` is set, until the opencode work loop lands (next issue updates the text).

## Capabilities

- `host-integration`: added: "OpenCode host"; modified: "Skills", "Plugin launcher", "Session start hook", "Session end hook"
- `operator-control`: modified: "Session attachments"

## Impact

* hosts/opencode/{bin/orchestrator.mjs, opencode.json, package.json, README.md, skills/**, plugins/orchestrator.js, hooks/*.mjs copies}
* test/host/opencode-host.test.ts (new)

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-62 edited `openspec/specs` directly in commit f00843f instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-62 issue text.

Commit summary: Added hosts/opencode/. It contains: bin/orchestrator.mjs, a third launcher copy pinned by hosts/opencode/package.json (0.4.0); opencode.json, a snippet that declares mcp.orchestrator_operator { type local, command [node, <hosts/opencode>/bin/orchestrator.mjs, mcp], timeout 180000 }; the import/run/review skills as the Codex edition with the tool prefix changed to orchestrator_operator_ and only the host-specific blocks rewritten; plugins/orchestrator.js, which on session.created runs the byte-copied hooks/session-start.mjs once and appends its line to the first chat.message text part and shows it as a toast; byte copies of both hook scripts; and a README. test/host/opencode-host.test.ts holds the copies and editions in step and drives the plugin with a fake client. Three CLI checks run behind ORCH_E2E_OPENCODE_HOST=1. The host-integration spec has a new OpenCode host requirement and changes to Skills, Plugin launcher, Session start hook and Session end hook. operator-control Session attachments has a new OpenCode stdio-close scenario.
