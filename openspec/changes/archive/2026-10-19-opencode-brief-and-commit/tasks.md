## 1. Implementation

- [x] 1.1 Workspace section for `opencode`: "You run with OpenCode permission rules in force and no sandbox: a command a rule does not allow fails with 'The user rejected permission to use this specific tool call.' and will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command, then continue with what you can." When `runner.opencode.permission` is `derived`, list the derived bash patterns the way the claude-code branch lists its rules; under `allow`, say every command is allowed.
- [x] 1.2 Reporting section: a tool-name line per kind: `mcp__orchestrator__<tool>` for claude-code and codex, `orchestrator_<tool>` for opencode. The codex-only "do not call the API from a command" rule stays codex-only; the opencode brief keeps the HTTP fallback (no sandbox blocks loopback) and still prefers the tools.
- [x] 1.3 `BriefInput.runner` gains `permission?: { mode: 'derived' | 'allow'; bashPatterns?: string[] }` filled for opencode; `sandbox` stays codex-only.
- [x] 1.4 `commitPolicyFor('opencode')` returns `runner.opencode.commit` (default `agent`); the daemon seals only under `daemon`; `ORCH_COMMIT_POLICY` is set as today. The brief's commit sentences key off the policy as for the other kinds.
- [x] 1.5 Fixture: a golden brief for an opencode launch under `derived` with two patterns and under `allow`.

## 2. Record

- [x] 2.1 Spec edits landed in 2ac69b2; change directory reconstructed at archive time
