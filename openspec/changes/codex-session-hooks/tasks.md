## 1. Host files

- [x] 1.1 hosts/codex/hooks/session-start.mjs and session-end.mjs, copied from hosts/claude-code/hooks
- [x] 1.2 hosts/codex/config.toml: `[features] hooks = true`, `[[hooks.SessionStart]]`, `[[hooks.SessionEnd]]`
- [x] 1.3 hosts/codex/README.md: session hooks section; skill discovery corrected

## 2. Tests

- [x] 2.1 test/host/codex-host.test.ts: the template's hook entries and `features.hooks`; the copies equal the originals
- [x] 2.2 the session end script with `{ "reason": "x" }` and no alive daemon exits 0 within one second
- [x] 2.3 a slice daemon, an attachment whose chain holds the test process, and the script run with Codex's SessionEnd input: the attachment ends with reason `other` and the claimed launch is released with keep
- [x] 2.4 when `codex` is on PATH, `codex --dangerously-bypass-hook-trust debug prompt-input` with the template's hooks ends the attachment with reason `other`

## 3. Finish

- [x] 3.1 Spec deltas for host-integration and operator-control; `openspec/specs/` is updated when the change is archived (after codex-host)
