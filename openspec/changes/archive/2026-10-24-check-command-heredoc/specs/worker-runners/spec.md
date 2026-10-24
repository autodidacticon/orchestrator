## MODIFIED Requirements

### Requirement: OpenCode runner command composition
The OpenCode runner SHALL spawn `DEFAULT_OPENCODE_COMMAND`, or `runner.opencode.command` when it is set:

`opencode run --format json {pure} --print-logs --log-level WARN -m {model} {variant} < {brief}`

The brief on stdin SHALL be the whole message; the template SHALL have no positional message and no `{allowedTools}` slot. stdin SHALL always be redirected: a run whose stdin stays open hangs after `message=init`. At every spawn the runner SHALL fill:
- `{pure}` with `--pure` when `runner.opencode.pure` is true (the default), and otherwise with nothing;
- `{variant}` with `--variant <effort>` when the launch has an effort, and otherwise with nothing; `{variant}` carries the effort slot, so `hasEffortSlot` is true for the template;
- `{model}` with the launch's `provider/model`, which the shell hands to `-m` as one word.

The command SHALL contain no token and no config path. Before spawning, the runner SHALL add to the launch environment:
- `OPENCODE_CONFIG_CONTENT`: the per-launch config JSON, which outranks a repository's own `opencode.json`;
- `XDG_DATA_HOME=<worktree>/.orchestrator/opencode-data` when `runner.opencode.dataDir` is `launch` (a private database, log, and `auth.json`; OAuth logins of the user are then not visible);
- `XDG_CONFIG_HOME=<worktree>/.orchestrator/opencode-config`, an existing empty directory, when `runner.opencode.ignoreUserConfig` is true.

The config JSON SHALL carry:
- `mcp.orchestrator`: `type: local`, `command: [<shim command>, ...<shim args>]`, `enabled: true`, and `timeout`, with no `environment` block. The shim inherits `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, and `ORCH_COMMIT_POLICY` from the agent environment;
- `snapshots: false` unless `runner.opencode.snapshots` is true;
- `share: "disabled"`;
- `permission`: the ruleset below.

The same JSON SHALL be written to `.orchestrator/opencode.json` with mode 0600 for debugging and the work loop, and never passed to opencode as a path.

MCP call timeout: opencode 1.18.30 cuts an MCP tool call at 60 000 ms by default and drops `mcp.timeout.execution` with a compatibility warning; the per-server `mcp.<id>.timeout` is honoured. `mcp.orchestrator.timeout` SHALL therefore be `runner.opencode.toolTimeoutMs` when it is set, and otherwise `maxWaitMs + 60000`. The config SHALL NOT emit `mcp.timeout`. The same key is the startup tools-fetch timeout, so a shim that hangs at startup is noticed late; a shim whose command cannot start fails at once and the run continues without the tools.

Permissions: under `runner.opencode.permission: derived` (the default) the ruleset SHALL be `{ "*": "deny", read, glob, grep, list, edit, write: "allow", "bash": { "*": "deny", "git *": "allow", <one "allow" per derived rule>, <one "allow" per check-command pattern> }, "orchestrator_*": "allow" }`, with no `ask` value anywhere. The catch-alls SHALL be `deny` because headless opencode 1.18.30 auto-rejects an `ask` and then ends the run after that step (`step_finish` reason `tool-calls`, exit 0), so the model never sees the refusal (test/fixtures/opencode/events/P-ask.jsonl). A `deny` returns "The user has specified a rule which prevents you from using this specific tool call." to the model and the run goes on (P-deny.jsonl), and the brief tells the model to turn that into a `needsAccess` question. The `deny` catch-all also overrides opencode's own `ask` defaults (`external_directory`, `doom_loop`). In 1.18.30 `write` is its own permission, not covered by `edit`, and there is no `patch` tool. A derived `Bash(x:*)` SHALL become the pattern `"x *"` and `Bash(x)` SHALL become `"x"`; other rules have no bash pattern. The catch-all SHALL come first in each map, as opencode takes the last matching rule. `"npm test *"` does not match a bare `npm test`. A pattern made only of `*`, `?` and whitespace, whether a derived rule or a check-command pattern, SHALL be skipped, so no pattern overwrites the bash `deny` catch-all whatever the rules or the check command hold. Under `allow` the ruleset SHALL be `{ "*": "allow" }`.

Chained commands: opencode 1.18.30 matches each command node of a bash call on its own: the text of each tree-sitter `command`, or of its `redirected_statement` when it has redirections, so a redirection stays part of its command (`npm test 2>&1` is matched whole, X-redirect-text.jsonl). Each part of a `&&`, `||`, `;`, `|` or lone-`&` chain, and each command inside a `( ... )` subshell, needs a rule that allows it, and a pattern holding a whole chain, or a piece holding a parenthesis, never matches (X-ampersand.jsonl, X-ampersand-whole.jsonl, X-subshell.jsonl, X-subshell-missplit.jsonl). `cd` is not matched against the bash rules (test/fixtures/opencode/events/X-*.jsonl, configs/X-*.json). So `git add <f> && git commit -m <m>` runs under `git *`. The check-command patterns SHALL come from splitting the effective check command the same way, outside quotes, at `&&`, `||`, `;`, `|`, `|&`, a lone `&`, newlines, `(` and `)`, with each part trimmed and duplicates dropped. A backslash SHALL escape the next character outside quotes and inside double quotes, so `echo "a \" && b"` is one command (X-escaped-quote.jsonl); single quotes have no escapes. The `&` of a redirection (`2>&1`, `>&`, `&>`, `<&`) and the `|` of `>|` SHALL stay in the command, a `$(...)`, backtick or `<(...)`/`>(...)` substitution SHALL stay whole in its command, quotes inside it included, and its inner commands SHALL be split the same way and get patterns of their own: opencode 1.18.30 matches the commands inside a `$(...)` or backtick substitution as well as the command that holds it, so `echo $(uname -s)` is denied under the pattern `echo $(uname -s)` alone and runs once `uname -s` is allowed too (X-subst-outer.jsonl, X-subst-inner.jsonl, X-backtick-outer.jsonl, X-backtick-inner.jsonl). An arithmetic `$((...))` SHALL stay whole with no inner patterns. The `{` and `}` words of a brace group SHALL be dropped, and so SHALL a piece that starts with the `}` word, such as the `} > log` of a redirected brace group. A heredoc body SHALL be dropped: after `<<WORD`, `<<-WORD`, `<<'WORD'` or `<<"WORD"` the lines following the line that carries it, up to and including the terminator line (leading tabs ignored under `<<-`), give no pattern, while the command carrying the `<<` keeps its own; a here-string `<<<` stays in its command. An unquoted `#` that starts a word SHALL drop the text through the end of the line. Heredoc bodies and comments are not command nodes, so a pattern from them could only over-allow. A pattern made only of `*`, `?` and whitespace SHALL never be returned. Known under-allows, where a command opencode matches may get no exact pattern of its own: a `case` pattern's `)` inside a substitution ends the substitution early. Process substitution was not probed: the splitter treats `<(...)` and `>(...)` like `$(...)`, so if opencode does not match their inner commands on their own, those inner patterns are a small over-allow of commands the check command already runs. A spawned launch reads the check command from its `.orchestrator/brief.json`, and the work loop passes the claim's `brief.checkCommand`.

Glob characters: opencode 1.18.30 turns `*` in a pattern into any run of characters and `?` into any one character, keeps `[` literal, and turns every backslash in both the pattern and the command into `/` before matching, so no escape for `*` or `?` exists: the pattern `cat probe-\*.txt` does not allow `cat probe-*.txt` (X-glob-escape.jsonl), while `cat probe-*.txt` allows `cat probe-other.txt` (X-glob-star.jsonl) and `cat probe-[ab].txt` allows only itself (X-glob-bracket.jsonl, X-glob-bracket-literal.jsonl). Each part SHALL be allowed verbatim, so a check command holding `*` or `?` yields a wildcard pattern: `node --test test/*.test.js` also allows `node --test test/<anything>.test.js`. A part ending in ` *` also allows the command without its last word, as opencode makes a trailing ` *` optional. The agent can already edit what the check command runs, so the wider pattern grants nothing the task does not have.

The derived rules SHALL be the composed allow list when there is one. Under an opencode run, where none is composed, they SHALL be composed the same way from the detected toolchain, `runner.claude.deriveTools`, `runner.claude.allowedTools`, and the argument rules.

`composeOpenCodeCommand(launch, policy)` and `openCodeConfig(settings, allowedTools, maxWaitMs, shim, checkCommand)` SHALL be exported for the work loop.

#### Scenario: Default composition
- **WHEN** an opencode launch with model `opencode/big-pickle` and effort `high` is spawned under the default `runner.opencode`
- **THEN** the command is `opencode run --format json --pure --print-logs --log-level WARN -m opencode/big-pickle --variant high < <brief>`, with no token and no config path

#### Scenario: Keys change the command
- **WHEN** `pure` is false, or the launch has no effort
- **THEN** the command has no `--pure`, or no `--variant`, respectively

#### Scenario: Per-launch config in the environment
- **WHEN** a launch is spawned with allowed rules `Bash(npm test:*)` and `Bash(git status)` and the default `maxWaitMs`
- **THEN** `OPENCODE_CONFIG_CONTENT` has `mcp.orchestrator.command` equal to the shim command, `mcp.orchestrator.timeout` 3660000, no `mcp.timeout`, `snapshots: false`, `share: "disabled"`, no `environment` block, and a bash ruleset denying `*` and allowing `git *`, `npm test *`, and `git status`
- **AND** `.orchestrator/opencode.json` holds the same JSON with mode 0600, and the child's stdin is the brief

#### Scenario: Derived ruleset lets a task finish
- **WHEN** an opencode launch is spawned under `derived` with no derived rules and the check command `npm ci --ignore-scripts && npm run build` in its brief.json
- **THEN** the ruleset holds no `ask` and allows `write`, and its bash map is `{ "*": "deny", "git *": "allow", "npm ci --ignore-scripts": "allow", "npm run build": "allow" }`, so both the check command and `git add <f> && git commit -m <m>` run

#### Scenario: Subshell, lone ampersand and escaped quote in the check command
- **WHEN** the check command is `(cd pkg && npm test)`, `npm run lint & npm test`, or `echo "a \" && b"`
- **THEN** the check-command patterns are `cd pkg` and `npm test`; `npm run lint` and `npm test`; and the single pattern `echo "a \" && b"`, one per command opencode matches

#### Scenario: Redirections stay with their command
- **WHEN** the check command is `npm test 2>&1 | tee out.txt`
- **THEN** the patterns are `npm test 2>&1` and `tee out.txt`

#### Scenario: Glob characters give a wildcard pattern
- **WHEN** the check command is `node --test test/*.test.js`
- **THEN** the pattern is `node --test test/*.test.js` verbatim, which opencode also matches against `node --test test/other.test.js`

#### Scenario: Heredoc bodies and comments give no pattern
- **WHEN** the check command is `cat <<EOF\n*\nEOF`, `node - <<'EOF'\nrm -rf build\nEOF`, or `npm test # && rm -rf ~`
- **THEN** the check-command patterns are `cat <<EOF`; `node - <<'EOF'`; and `npm test`, and the bash map still denies `*`

#### Scenario: The bash catch-all stays denied
- **WHEN** a launch is spawned under `derived` with any derived rules and any check command, including the rule `Bash(*)` or a check command one of whose parts is `*`
- **THEN** the bash map's `*` is `deny` and no pattern made only of `*`, `?` and whitespace is allowed

#### Scenario: Commands inside a substitution get their own patterns
- **WHEN** the check command is `test -n "$(git status --porcelain && true)" || true`, or `diff <(sort a) <(sort b)`
- **THEN** the patterns are `test -n "$(git status --porcelain && true)"`, `git status --porcelain` and `true`; and `diff <(sort a) <(sort b)`, `sort a` and `sort b`

#### Scenario: Redirected brace group
- **WHEN** the check command is `{ npm test; } > log`
- **THEN** the only pattern is `npm test`

#### Scenario: Tool timeout configured
- **WHEN** `runner.opencode.toolTimeoutMs` is 120000
- **THEN** `mcp.orchestrator.timeout` is 120000

#### Scenario: Data and config isolation
- **WHEN** `dataDir` is `launch` and `ignoreUserConfig` is true
- **THEN** `XDG_DATA_HOME` is under `<worktree>/.orchestrator/` and `XDG_CONFIG_HOME` names an existing empty directory there

#### Scenario: Real OpenCode run publishes three tasks
- **WHEN** `ORCH_E2E_OPENCODE=1 npx vitest run test/e2e/opencode.test.ts` runs with `opencode` on PATH and no OpenCode login, at capacity 2 with model `opencode/big-pickle`, `permission: derived` and the check command `node --test` allowed through the file rule `Bash(node:*)`, which the derived ruleset turns into the pattern `node *`, on a graph where T1 commits a file, T2 asks a `needsDecision` question that is answered only after 75 s, and T3 depends on both
- **THEN** the run finishes with every task `done` and one `Orchestrator-Task` trailer per task on the integration branch, every launch row has runner `opencode`, and no `needsAccess` question names `git commit`, because the agent commits under `commit: agent`
- **AND** every launch that did not die at startup has `tokens.input` and `tokens.output` above 0, `costUsd` 0 and `usageSource` `opencode`, and a question answered after 75 s reaches the agent, because `mcp.orchestrator.timeout` is above 60 s
- **AND** in the second case a task told to run `uname -s`, which is outside the patterns, gets the deny error, asks with a `needsAccess` question naming `uname`, and finishes as the answer says. Under `deny` the model continues (P-deny.jsonl), where an auto-rejected `ask` would end the run (P-ask.jsonl)
- **AND** without the variable, or without `opencode` on PATH, the file is skipped; the latter warns naming the binary
