## 1. Splitter

- [x] 1.1 Drop heredoc bodies after `<<WORD`, `<<-WORD`, `<<'WORD'` and `<<"WORD"` through the terminator line; keep `<<<` in its command
- [x] 1.2 Drop an unquoted `#` comment that starts a word, through the end of the line
- [x] 1.3 Never return a pattern made only of `*`, `?` and whitespace; make `openCodePermission` skip such a pattern from any source
- [x] 1.4 Keep `$(...)`, backtick and `<(...)` substitutions whole and give their inner commands patterns; keep `$((...))` whole
- [x] 1.5 Drop the `} ...` piece of a redirected brace group

## 2. Evidence

- [x] 2.1 Probe OpenCode 1.18.30 with test/fixtures/opencode/configs/probe-bash-rule.mjs: X-subst-outer, X-subst-inner, X-backtick-outer, X-backtick-inner
- [x] 2.2 Record the result in test/fixtures/opencode/README.md and in the worker-runners delta

## 3. Tests

- [x] 3.1 Unit tests for heredocs, comments, substitutions, the redirected brace group and glob-only patterns
- [x] 3.2 A unit test that `openCodePermission('derived', ...)` keeps `bash['*']` as `deny` for any check command or rule
- [x] 3.3 `npm test` green; `openspec validate check-command-heredoc --strict` passes
