## Why

`checkCommandPatterns` (ORC-65) split the check command only at `&&`, `||`, `;`, `|` and newlines outside quotes. The OPENCODE-M3 review found three mis-splits: `(cd pkg && npm test)` gave `['(cd pkg', 'npm test)']`, `npm run lint & npm test` gave one pattern for two commands, and `echo "a \" && b"` was split inside the quoted string. None of those patterns matches a command opencode sees, so under `derived` the agent could not run its own check command and had to ask with `needsAccess`. The spec also called the patterns exact, while opencode treats `*` and `?` in a pattern as wildcards.

The opencode 1.18.30 binary shows the matcher (`Wildcard.match`): both strings have every `\` turned into `/`, the pattern's regex characters (including `[` and `]`) are escaped, `*` becomes `.*` and `?` becomes `.`, and a trailing ` .*` becomes optional. The bash tool matches the text of each tree-sitter `command` node, or of its parent `redirected_statement`. Probes under test/fixtures/opencode (X-glob-*, X-subshell*, X-ampersand*, X-escaped-quote, X-redirect-text) confirm each point.

## What Changes

1. The splitter also splits at a lone `&`, `|&`, `(` and `)`, keeps the `&` of `2>&1`, `>&`, `&>`, `<&` and the `|` of `>|` in the command, keeps a `$(...)` substitution whole, drops a brace group's `{` and `}`, and honours a backslash escape outside quotes and inside double quotes.
2. Glob characters: opencode has no escape for `*` or `?` (probed: `cat probe-\*.txt` does not allow `cat probe-*.txt`), so a part is still copied verbatim and the spec states that a check command holding `*` or `?` yields a wildcard pattern; `[` is literal.
3. worker-runners "OpenCode runner command composition" states the new splitting, the glob behaviour and the fixtures behind them.

## Capabilities

- `worker-runners`: modified: "OpenCode runner command composition"

## Impact

* src/runner/opencode.ts
* test/runner/opencode.test.ts
* test/fixtures/opencode/ (probe harness configs/probe-bash-rule.mjs, configs/X-*.json and events/X-*.jsonl for eleven probes, README)
* The opencode brief (src/brief/compose.ts) already lists the patterns verbatim, so a wildcard pattern shows as such; it is not changed.
