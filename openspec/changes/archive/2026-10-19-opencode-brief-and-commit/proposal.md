## Why

An opencode agent would read a brief that names tools it does not have (`mcp__orchestrator__*`) and says nothing about permission rejections, so the first auto-rejected command becomes a stuck launch instead of a `needsAccess` question.

## What Changes

1. Workspace section for `opencode`: "You run with OpenCode permission rules in force and no sandbox: a command a rule does not allow fails with 'The user rejected permission to use this specific tool call.' and will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command, then continue with what you can." When `runner.opencode.permission` is `derived`, list the derived bash patterns the way the claude-code branch lists its rules; under `allow`, say every command is allowed.
2. Reporting section: a tool-name line per kind: `mcp__orchestrator__<tool>` for claude-code and codex, `orchestrator_<tool>` for opencode. The codex-only "do not call the API from a command" rule stays codex-only; the opencode brief keeps the HTTP fallback (no sandbox blocks loopback) and still prefers the tools.
3. `BriefInput.runner` gains `permission?: { mode: 'derived' | 'allow'; bashPatterns?: string[] }` filled for opencode; `sandbox` stays codex-only.
4. `commitPolicyFor('opencode')` returns `runner.opencode.commit` (default `agent`); the daemon seals only under `daemon`; `ORCH_COMMIT_POLICY` is set as today. The brief's commit sentences key off the policy as for the other kinds.
5. Fixture: a golden brief for an opencode launch under `derived` with two patterns and under `allow`.

## Capabilities

- `agent-protocol`: modified: "Standalone brief", "Check command and tool rules in the brief", "Codex brief reports through the MCP server"
- `worker-runners`: modified: "Sandbox and commit policy"

## Impact

* src/brief/compose.ts, src/loop/orchestrator.ts (brief input and commitPolicyFor)
* test/loop/brief.test.ts, test/loop/brief-health.test.ts (the existing brief tests), test/fixtures/brief/** (new golden files)

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-61 edited `openspec/specs` directly in commit 2ac69b2 instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-61 issue text.

Commit summary: Opencode launches now get their own brief text. The Workspace section has the OpenCode permission paragraph: a command a rule does not allow fails with 'The user rejected permission to use this specific tool call.', is not approved at runtime, and is asked for with a needsAccess question. Under derived it lists the bash patterns (git * first); under allow it says every command and tool is allowed. Both forms carry the claimed-launch caveat. The Reporting section names orchestrator_heartbeat/report/block/inbox/log and keeps the API line and the fallback. The retry diagnosis line names permission rules instead of a sandbox. BriefInput.runner (now the BriefRunner type in workspace.ts) gains permission { mode, bashPatterns? }, which Orchestrator.briefInput fills for opencode through openCodePermissionFor(). Golden briefs are in test/fixtures/brief. The claude-code and codex goldens were written from the base compose before any change (commit bd0a88f). The agent-protocol and worker-runners specs are updated. Commits bd0a88f, e25c863, 0550d7a.
