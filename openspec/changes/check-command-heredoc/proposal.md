## Why

The CODEX-M5/OPENCODE-M4 review (2026-10-24, reproduced at a094d2b) found that `checkCommandPatterns` knew nothing of heredocs or `#` comments. `cat <<EOF\n*\nEOF` gave the pattern `*`, which overwrote the bash `deny` catch-all under `runner.opencode.permission: derived` and so allowed every command. Any heredoc body line (`rm -rf build` inside `node - <<'EOF'`) and any comment text (`npm test # && rm -rf ~`) became an allow pattern too. Neither is a command node, so OpenCode never matches them, and every such pattern only over-allows. The rule that a `$(...)` substitution's inner commands get no pattern had no probe behind it. A probe now shows that OpenCode 1.18.30 matches the commands inside `$(...)` and backticks, so that rule under-allowed.

## What Changes

- The splitter drops heredoc bodies (`<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`) up to and including the terminator line, and keeps the command that carries the `<<`. A here-string `<<<` stays in its command.
- The splitter drops an unquoted `#` comment that starts a word, through the end of the line.
- No pattern made only of `*`, `?` and whitespace is ever emitted. `openCodePermission` also skips any such pattern, derived or from the check command, so nothing overwrites the bash `*: deny` catch-all.
- `$(...)`, backtick and `<(...)`/`>(...)` substitutions stay whole in their command, and their inner commands get patterns of their own (probed: test/fixtures/opencode/events/X-subst-*.jsonl, X-backtick-*.jsonl). `$((...))` arithmetic stays whole with no inner patterns. A substitution inside double quotes that holds a quote is scanned correctly.
- The `} > log` piece of a redirected brace group is dropped.
- The spec names a `case` pattern's `)` inside a substitution as a known under-allow. Process substitution was not probed, so its inner patterns may be a small over-allow of commands the check command already runs.

## Capabilities

### Modified Capabilities
- `worker-runners`: "OpenCode runner command composition" covers the heredoc, comment, glob-only and substitution rules and the probe behind them.

## Impact

- src/runner/opencode.ts (`checkCommandPatterns`, `openCodePermission`), test/runner/opencode.test.ts, test/fixtures/opencode (four probe configs and events, README).
