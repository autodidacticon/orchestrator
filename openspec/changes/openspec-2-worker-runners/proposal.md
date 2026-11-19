## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Ten of the eleven requirements of `worker-runners` are over the limit. This change handles nine of them: "Runner kinds and defaults" (2311), "Per-kind effort sets" (1028), "Runner dispatch by launch kind" (868), "Sandbox and commit policy" (2767), "Codex usage parsing" (727), "OpenCode runner command composition" (8539), "OpenCode usage parsing" (1342), "OpenCode e2e fixture recording" (1108), "Codex network access override" (1857). It splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. "Codex runner command composition" (1936 characters) is left to the later migration (OS2), since ORC-142 restates it in this run; it stays over the limit until then. This change is part of the OpenSpec 2.1 migration (ORC-139, task ORC-159), based on commit c4fa94d.

## What Changes

- MODIFIED "Runner kinds and defaults" (2311 characters): header and all 8 scenarios kept unchanged; the description is cut to 331 characters. The moved text is in 5 ADDED requirements: "Runner kind resolution", "Default model per runner kind", "Codex runner configuration block", "OpenCode runner configuration block", "Runner kind on the operator surfaces".
- MODIFIED "Per-kind effort sets" (1028 characters): header and all 5 scenarios kept unchanged; the description is cut to 424 characters. The moved text is in 3 ADDED requirements: "Effort validated against its kind", "Task effort selectors against the union", "Effort in place of a missing level".
- MODIFIED "Runner dispatch by launch kind" (868 characters): header and all 6 scenarios kept unchanged; the description is cut to 371 characters. The moved text is in 3 ADDED requirements: "Kill by launch id across runners", "Launch kind without a registered runner", "Allow list per launch kind".
- MODIFIED "Sandbox and commit policy" (2767 characters): header and all 8 scenarios kept unchanged; the description is cut to 401 characters. The moved text is in 8 ADDED requirements: "OpenCode commit policy", "Codex commit policy derived from the sandbox", "Commit and sandbox runtime overrides", "Commit policy fixed on the launch", "Commit policy in the agent environment", "Brief under the agent commit policy", "Brief under the daemon commit policy", "Codex brief names its sandbox".
- MODIFIED "Codex usage parsing" (727 characters): header and all 3 scenarios kept unchanged; the description is cut to 461 characters. The moved text is in 2 ADDED requirements: "Codex usage source and unset fields", "Codex log without usage".
- MODIFIED "OpenCode usage parsing" (1342 characters): header and all 6 scenarios kept unchanged; the description is cut to 447 characters. The moved text is in 3 ADDED requirements: "OpenCode log read in full", "OpenCode step usage sums", "OpenCode usage source and turns".
- MODIFIED "OpenCode e2e fixture recording" (1108 characters): header and all 5 scenarios kept unchanged; the description is cut to 342 characters. The moved text is in 2 ADDED requirements: "Fixture lines redacted as JSON or text", "Fixture redaction rules".
- MODIFIED "OpenCode runner command composition" (8539 characters): header and all 14 scenarios kept unchanged; the description is cut to 417 characters. The moved text is in 26 ADDED requirements: "OpenCode template slots", "OpenCode config in the launch environment", "OpenCode data and config isolation", "OpenCode per-launch config content", "OpenCode MCP call timeout", "OpenCode MCP timeout key", "OpenCode permission ruleset", "OpenCode deny catch-alls", "OpenCode catch-all first", "Derived rules as bash patterns", "Glob-only patterns kept out of the ruleset", "OpenCode command node matching", "OpenCode chain parts matched alone", "Check-command splitting", "Backslash escapes in the check command", "Redirection operators stay in their command", "Substitutions stay whole in their command", "Inner commands of a substitution", "Brace group words dropped", "Heredoc bodies and comments dropped", "Glob-only check-command patterns", "OpenCode glob characters", "No escape for OpenCode glob characters", "Check-command parts allowed verbatim", "OpenCode derived rules", "OpenCode composition exports".
- MODIFIED "Codex network access override" (1857 characters): header and all 6 scenarios kept unchanged; the description is cut to 478 characters. The moved text is in 5 ADDED requirements: "Codex network access surfaces", "Codex network access in the configuration report", "Codex network access for later launches", "Codex network access under every sandbox and kind", "Codex settings read at command composition".
- 57 ADDED requirements, each with a description of at most 500 characters and at least one WHEN/THEN scenario of its own. No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened: the original descriptions hold 108, the cut and ADDED ones 115. The 7 more come from added lead-ins: four fact lead-ins, two repeated list lead-ins of the OpenCode usage parser, and the repeated lead-in of the split launch-environment sentence (see below).

### Split sentences

- "OpenCode runner command composition", the sentence "Before spawning, the runner SHALL add to the launch environment:" with its three list items (503 characters as one sentence) is split between its items, with its lead-in repeated and "the runner" made explicit as "the OpenCode runner": the item `OPENCODE_CONFIG_CONTENT` goes to **OpenCode config in the launch environment**, the items `XDG_DATA_HOME` and `XDG_CONFIG_HOME` to **OpenCode data and config isolation**. The items are unchanged.
- "OpenCode runner command composition", the sentence "The `&` of a redirection ... (X-subst-outer.jsonl, X-subst-inner.jsonl, X-backtick-outer.jsonl, X-backtick-inner.jsonl)." (621 characters) has no semicolon. With its first clause split off, the rest is still 522 characters, so it is split at both of its clause joints ", a" and ", and its inner commands":
  - Part 1, in **Redirection operators stay in their command**: "The `&` of a redirection (`2>&1`, `>&`, `&>`, `<&`) and the `|` of `>|` SHALL stay in the command." (the comma at the joint became a period).
  - Part 2, in **Substitutions stay whole in their command**: "A `$(...)`, backtick or `<(...)`/`>(...)` substitution SHALL stay whole in its command, quotes inside it included." ("a" capitalized, the comma at the joint became a period).
  - Part 3, in **Inner commands of a substitution**: "its inner commands SHALL be split the same way" became "The inner commands of a substitution SHALL be split the same way as the check command", the subject repeated and "the same way" made explicit; the rest of the clause, from "and get patterns of their own", is unchanged.
- "OpenCode runner command composition", the sentence "Glob characters: opencode 1.18.30 turns ... (X-glob-bracket.jsonl, X-glob-bracket-literal.jsonl)." (516 characters) has no semicolon and no SHALL. It is split at its clause joint ", so":
  - Part 1, in **OpenCode glob characters**: "Glob characters: opencode 1.18.30 turns `*` in a pattern into any run of characters and `?` into any one character, keeps `[` literal, and turns every backslash in both the pattern and the command into `/` before matching." (the comma at the joint became a period).
  - Part 2, in **No escape for OpenCode glob characters**: "No escape for `*` or `?` exists: the pattern `cat probe-\*.txt` does not allow `cat probe-*.txt` (X-glob-escape.jsonl), while `cat probe-*.txt` allows `cat probe-other.txt` (X-glob-star.jsonl) and `cat probe-[ab].txt` allows only itself (X-glob-bracket.jsonl, X-glob-bracket-literal.jsonl)." (the joint word "so" dropped, "no" capitalized).

### Added lead-ins

- Fact lead-in "The OpenCode runner's bash patterns SHALL rest on these facts of opencode 1.18.30:", before text about opencode that has no SHALL of its own and that no SHALL sentence can carry within 500 characters: in **OpenCode command node matching** (before "Chained commands: opencode 1.18.30 matches each command node ..." and "`cd` is not matched ..."; with "The check-command patterns SHALL come from splitting ..." the two sentences alone are 512 characters), **OpenCode chain parts matched alone** (before "Each part of a `&&`, ..." and "So `git add <f> && git commit -m <m>` runs under `git *`."), **OpenCode glob characters** (before part 1 of the glob sentence) and **No escape for OpenCode glob characters** (before part 2).
- List lead-in "The parser of `OpenCodeRunner.readUsage` SHALL:" ("The parser SHALL:" with "The parser" made explicit), before the unchanged bullets "- read the whole log, ..." in **OpenCode log read in full** and "- for every line with `type: "step_finish"`, ..." in **OpenCode step usage sums**.
- No other bullet was moved without its list's lead-in: the bullets of the template slots and of the per-launch config JSON move with their own lead-in sentences ("At every spawn the runner SHALL fill:", "The config JSON SHALL carry:"), with the references made explicit as listed below.

### Moved sentences: "Runner kinds and defaults"

- "The configuration SHALL carry `runner.kind`, one of `claude-code`, `codex`, and `opencode`, defaulting ..." stays, unchanged.
- "`runner.kind` SHALL resolve through the configuration layers as the key `runnerKind`: an ..." moves to **Runner kind resolution**, unchanged.
- "A value outside the kinds SHALL be refused at configuration time naming ..." stays, unchanged.
- "Each kind SHALL have its own default model: `claude-opus-5-5` for `claude-code`, `gpt-6-astra` ..." moves to **Default model per runner kind**, unchanged.
- "`runner.codex` SHALL carry `command` (unset by default, so the runner's built-in template ..." moves to **Codex runner configuration block**, unchanged.
- "`runner.opencode` SHALL carry `command` (unset by default), `model` (a `provider/model` id), `effort`, ..." moves to **OpenCode runner configuration block**, unchanged.
- "The run default `model` and `effort` SHALL be those of the kind ..." moves to **Default model per runner kind**, unchanged.
- "Every operator surface SHALL expose the kind and the per-kind keys." moves to **Runner kind on the operator surfaces**, unchanged.
- "These are `orchestrator-ctl start --set runnerKind=... --set codex.<leaf>=...`, `orchestrator-ctl config --runner-kind --sandbox ..." moves to **Runner kind on the operator surfaces**, with "These are" made explicit as "The operator surfaces are".
- "Each surface that names a default SHALL name both kinds' defaults." moves to **Runner kind on the operator surfaces**, unchanged.

### Moved sentences: "Per-kind effort sets"

- "Each runner kind SHALL accept its own set of effort levels: `claude-code` ..." stays, unchanged.
- "The set SHALL be a superset check: a model of the kind ..." stays, unchanged.
- "`runner.claude.effort`, `runner.codex.effort`, and `runner.opencode.effort` in the file, and an `effort` argument, SHALL ..." moves to **Effort validated against its kind**, unchanged.
- "A task's `effort` selector, in the graph file or from an import ..." moves to **Task effort selectors against the union**, unchanged.
- "Each kind SHALL define the level it runs at in place of ..." moves to **Effort in place of a missing level**, unchanged.

### Moved sentences: "Runner dispatch by launch kind"

- "The daemon SHALL hold one agent runner per runner kind behind a ..." stays, unchanged.
- "A row without a kind SHALL be treated as `claude-code`." stays, unchanged.
- "Killing by launch id, where only the id is known, SHALL be ..." moves to **Kill by launch id across runners**, unchanged.
- "A launch whose kind has no registered runner SHALL fail at spawn ..." moves to **Launch kind without a registered runner**, unchanged.
- "The allow list SHALL be given only to the brief of a `claude-code` launch." moves to **Allow list per launch kind**, unchanged.
- "Because the kind on the row comes from the task's `runner` selector ..." moves to **Allow list per launch kind**, unchanged.

### Moved sentences: "Sandbox and commit policy"

- "The configuration SHALL carry `runner.codex.sandbox` with one of `read-only`, `workspace-write`, or `danger-full-access`, ..." stays, unchanged.
- "Each runner kind SHALL carry a commit policy, `runner.<kind>.commit`, with one of ..." stays, unchanged.
- "`runner.claude.commit` SHALL default to `agent`." stays, unchanged.
- "OpenCode has no sandbox, only per-tool permission rules, so nothing stands between ..." moves to **OpenCode commit policy**, unchanged.
- "When `runner.codex.commit` is unset it SHALL be derived from the sandbox in ..." moves to **Codex commit policy derived from the sandbox**, unchanged.
- "The reason is that under `workspace-write` Codex cannot run `git add` or ..." moves to **Codex commit policy derived from the sandbox**, unchanged.
- "`codex.sandbox`, `codex.commit`, `claude.commit`, and `opencode.commit` SHALL be accepted as runtime overrides that ..." moves to **Commit and sandbox runtime overrides**, unchanged.
- "A derived value moves with a sandbox override, and an explicit `commit` ..." moves to **Commit and sandbox runtime overrides**, unchanged.
- "The policy SHALL be resolved from the launch's runner kind when the ..." moves to **Commit policy fixed on the launch**, with "The policy SHALL" made explicit as "The commit policy SHALL".
- "An `opencode` launch has no sandbox in its brief input." moves to **Commit policy fixed on the launch**, unchanged.
- "A row without a policy SHALL be treated as `agent`." moves to **Commit policy fixed on the launch**, with "A row without a policy" made explicit as "A launch row without a commit policy".
- "Under `daemon` the daemon SHALL set `ORCH_COMMIT_POLICY=daemon` in the agent's environment and ..." moves to **Commit policy in the agent environment**, unchanged.
- "The brief SHALL follow the policy." moves to **Brief under the agent commit policy**, with "follow the policy." made explicit as "follow the commit policy.".
- "Under `agent` it SHALL tell the agent to commit all work and ..." moves to **Brief under the agent commit policy**, with "Under `agent` it SHALL" made explicit as "Under `agent` the brief SHALL".
- "It SHALL allow rebasing the launch branch onto the integration head, and ..." moves to **Brief under the agent commit policy**, with "It SHALL allow" made explicit as "The brief under `agent` SHALL allow".
- "Under `daemon` it SHALL tell the agent to leave its changes in ..." moves to **Brief under the daemon commit policy**, with "Under `daemon` it SHALL" made explicit as "Under `daemon` the brief SHALL".
- "It SHALL say the orchestrator rebases the branch at verification, and tell ..." moves to **Brief under the daemon commit policy**, with "It SHALL say" made explicit as "The brief under `daemon` SHALL say".
- "Under `daemon` none of the agent-side git-write instructions SHALL appear." moves to **Brief under the daemon commit policy**, unchanged.
- "A `codex` launch's brief SHALL also name its sandbox mode and tell ..." moves to **Codex brief names its sandbox**, unchanged.

### Moved sentences: "Codex usage parsing"

- "`CodexRunner.readUsage` SHALL read the launch log." stays, unchanged.
- "The parser SHALL:" stays, unchanged.
- "- read at most the last 256 KiB, line by line;" stays, unchanged.
- "- `JSON.parse` each line and skip lines that fail;" stays, unchanged.
- "- sum `usage` over every `turn.completed` line into `tokens`: `input_tokens` to `input` ..." stays, unchanged.
- "The usage SHALL have `source: 'codex'`." moves to **Codex usage source and unset fields**, unchanged.
- "`costUsd`, `durationMs`, and `turns` SHALL be left unset: one exec is one ..." moves to **Codex usage source and unset fields**, unchanged.
- "A log without a `turn.completed` that has input and output counts SHALL ..." moves to **Codex log without usage**, unchanged.

### Moved sentences: "OpenCode usage parsing"

- "`OpenCodeRunner.readUsage` SHALL read the launch log." stays, unchanged.
- "The parser SHALL:" stays, unchanged.
- "- read the whole log, line by line, streaming the file so ..." moves to **OpenCode log read in full**, unchanged.
- "OpenCode reports usage per step, not as a running total, so a ..." moves to **OpenCode log read in full**, unchanged.
- "- skip a line of more than 64 KiB (65536 bytes of ..." stays, unchanged.
- "The cap SHALL be measured in UTF-8 bytes both when the log ..." stays, unchanged.
- "- `JSON.parse` each line and skip lines that fail;" stays, unchanged.
- "- for every line with `type: "step_finish"`, add `part.tokens.input + part.tokens.cache.read` to ..." moves to **OpenCode step usage sums**, unchanged.
- "The usage SHALL have `source: 'opencode'`, `turns` the number of `step_finish` lines ..." moves to **OpenCode usage source and turns**, unchanged.
- "A log without a `step_finish` that has input and output counts SHALL ..." moves to **OpenCode usage source and turns**, unchanged.

### Moved sentences: "OpenCode e2e fixture recording"

- "The opt-in OpenCode e2e (test/e2e/opencode.test.ts) SHALL write fixtures only under `ORCH_E2E_OPENCODE_RECORD=1`, copying ..." stays, unchanged.
- "Before writing, the recorder SHALL redact each line: a line that parses ..." moves to **Fixture lines redacted as JSON or text**, unchanged.
- "In each string, every scratch path (the run directory, with and without ..." moves to **Fixture redaction rules**, with "In each string," made explicit as "In each string the recorder redacts,".
- "A committed OpenCode fixture SHALL carry no email address other than an `example.invalid` one." stays, unchanged.

### Moved sentences: "OpenCode runner command composition"

- "The OpenCode runner SHALL spawn `DEFAULT_OPENCODE_COMMAND`, or `runner.opencode.command` when it is set:" stays, unchanged.
- "`opencode run --format json {pure} --print-logs --log-level WARN -m {model} {variant} < {brief}`" stays, unchanged.
- "The brief on stdin SHALL be the whole message; the template SHALL ..." stays, unchanged.
- "At every spawn the runner SHALL fill:" moves to **OpenCode template slots**, with "the runner SHALL fill" made explicit as "the OpenCode runner SHALL fill".
- "- `{pure}` with `--pure` when `runner.opencode.pure` is true (the default), and otherwise with nothing;" moves to **OpenCode template slots**, unchanged.
- "- `{variant}` with `--variant <effort>` when the launch has an effort, and ..." moves to **OpenCode template slots**, unchanged.
- "- `{model}` with the launch's `provider/model`, which the shell hands to `-m` ..." moves to **OpenCode template slots**, unchanged.
- "The command SHALL contain no token and no config path." moves to **OpenCode template slots**, unchanged.
- "Before spawning, the runner SHALL add to the launch environment:" is split between its list items (see "Split sentences"), with its lead-in repeated in **OpenCode config in the launch environment** and **OpenCode data and config isolation** and "the runner SHALL add" made explicit as "the OpenCode runner SHALL add".
- "- `OPENCODE_CONFIG_CONTENT`: the per-launch config JSON, which outranks a repository's own `opencode.json`;" moves to **OpenCode config in the launch environment**, unchanged.
- "- `XDG_DATA_HOME=<worktree>/.orchestrator/opencode-data` when `runner.opencode.dataDir` is `launch` (a private database, log, and `auth.json`; ..." moves to **OpenCode data and config isolation**, unchanged.
- "- `XDG_CONFIG_HOME=<worktree>/.orchestrator/opencode-config`, an existing empty directory, when `runner.opencode.ignoreUserConfig` is true." moves to **OpenCode data and config isolation**, unchanged.
- "The config JSON SHALL carry:" moves to **OpenCode per-launch config content**, with "The config JSON SHALL carry:" made explicit as "The OpenCode per-launch config JSON SHALL carry:".
- "- `mcp.orchestrator`: `type: local`, `command: [<shim command>, ...<shim args>]`, `enabled: true`, and ..." moves to **OpenCode per-launch config content**, unchanged.
- "The shim inherits `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, and `ORCH_COMMIT_POLICY` from the agent environment;" moves to **OpenCode per-launch config content**, unchanged.
- "- `snapshots: false` unless `runner.opencode.snapshots` is true;" moves to **OpenCode per-launch config content**, unchanged.
- "- `share: "disabled"`;" moves to **OpenCode per-launch config content**, unchanged.
- "- `permission`: the ruleset below." moves to **OpenCode per-launch config content**, with "the ruleset below." made explicit as "the ruleset of "OpenCode permission ruleset".".
- "The same JSON SHALL be written to `.orchestrator/opencode.json` with mode 0600 for ..." moves to **OpenCode config in the launch environment**, unchanged.
- "MCP call timeout: opencode 1.18.30 cuts an MCP tool call at 60 ..." moves to **OpenCode MCP call timeout**, unchanged.
- "`mcp.orchestrator.timeout` SHALL therefore be `runner.opencode.toolTimeoutMs` when it is set, and otherwise `maxWaitMs + 60000`." moves to **OpenCode MCP call timeout**, unchanged.
- "The config SHALL NOT emit `mcp.timeout`." moves to **OpenCode MCP timeout key**, with "The config SHALL NOT" made explicit as "The OpenCode per-launch config SHALL NOT".
- "The same key is the startup tools-fetch timeout, so a shim that ..." moves to **OpenCode MCP timeout key**, with "The same key is" made explicit as "The key `mcp.orchestrator.timeout` is".
- "Permissions: under `runner.opencode.permission: derived` (the default) the ruleset SHALL be `{ "*": ..." moves to **OpenCode permission ruleset**, unchanged.
- "The catch-alls SHALL be `deny` because headless opencode 1.18.30 auto-rejects an `ask` ..." moves to **OpenCode deny catch-alls**, unchanged.
- "A `deny` returns "The user has specified a rule which prevents you ..." moves to **OpenCode deny catch-alls**, unchanged.
- "The `deny` catch-all also overrides opencode's own `ask` defaults (`external_directory`, `doom_loop`)." moves to **OpenCode catch-all first**, unchanged.
- "In 1.18.30 `write` is its own permission, not covered by `edit`, and ..." moves to **OpenCode permission ruleset**, with "In 1.18.30" made explicit as "In opencode 1.18.30".
- "A derived `Bash(x:*)` SHALL become the pattern `"x *"` and `Bash(x)` SHALL ..." moves to **Derived rules as bash patterns**, unchanged.
- "The catch-all SHALL come first in each map, as opencode takes the ..." moves to **OpenCode catch-all first**, unchanged.
- "`"npm test *"` does not match a bare `npm test`." moves to **Derived rules as bash patterns**, unchanged.
- "A pattern made only of `*`, `?` and whitespace, whether a derived ..." moves to **Glob-only patterns kept out of the ruleset**, unchanged.
- "Under `allow` the ruleset SHALL be `{ "*": "allow" }`." moves to **OpenCode permission ruleset**, unchanged.
- "Chained commands: opencode 1.18.30 matches each command node of a bash call ..." moves to **OpenCode command node matching**, unchanged.
- "Each part of a `&&`, `||`, `;`, `|` or lone-`&` chain, and ..." moves to **OpenCode chain parts matched alone**, unchanged.
- "`cd` is not matched against the bash rules (test/fixtures/opencode/events/X-*.jsonl, configs/X-*.json)." moves to **OpenCode command node matching**, unchanged.
- "So `git add <f> && git commit -m <m>` runs under `git *`." moves to **OpenCode chain parts matched alone**, unchanged.
- "The check-command patterns SHALL come from splitting the effective check command the ..." moves to **Check-command splitting**, with "the effective check command the same way," made explicit as "the effective check command the same way opencode 1.18.30 matches a chain,".
- "A backslash SHALL escape the next character outside quotes and inside double ..." moves to **Backslash escapes in the check command**, unchanged.
- "The `&` of a redirection (`2>&1`, `>&`, `&>`, `<&`) and the `|` ..." is split (see "Split sentences"): part 1 moves to **Redirection operators stay in their command**, part 2 moves to **Substitutions stay whole in their command**, part 3 moves to **Inner commands of a substitution**.
- "An arithmetic `$((...))` SHALL stay whole with no inner patterns." moves to **Substitutions stay whole in their command**, unchanged.
- "The `{` and `}` words of a brace group SHALL be dropped, ..." moves to **Brace group words dropped**, unchanged.
- "A heredoc body SHALL be dropped: after `<<WORD`, `<<-WORD`, `<<'WORD'` or `<<"WORD"` ..." moves to **Heredoc bodies and comments dropped**, unchanged.
- "An unquoted `#` that starts a word SHALL drop the text through ..." moves to **Heredoc bodies and comments dropped**, unchanged.
- "Heredoc bodies and comments are not command nodes, so a pattern from ..." moves to **Heredoc bodies and comments dropped**, unchanged.
- "A pattern made only of `*`, `?` and whitespace SHALL never be returned." moves to **Glob-only check-command patterns**, unchanged.
- "Known under-allows, where a command opencode matches may get no exact pattern ..." moves to **Glob-only check-command patterns**, unchanged.
- "Process substitution was not probed: the splitter treats `<(...)` and `>(...)` like ..." moves to **Substitutions stay whole in their command**, unchanged.
- "A spawned launch reads the check command from its `.orchestrator/brief.json`, and the ..." moves to **Check-command splitting**, unchanged.
- "Glob characters: opencode 1.18.30 turns `*` in a pattern into any run ..." is split (see "Split sentences"): part 1 moves to **OpenCode glob characters**, part 2 moves to **No escape for OpenCode glob characters**.
- "Each part SHALL be allowed verbatim, so a check command holding `*` ..." moves to **Check-command parts allowed verbatim**, with "Each part SHALL" made explicit as "Each check-command part SHALL".
- "A part ending in ` *` also allows the command without its ..." moves to **Check-command parts allowed verbatim**, unchanged.
- "The agent can already edit what the check command runs, so the ..." moves to **Check-command parts allowed verbatim**, unchanged.
- "The derived rules SHALL be the composed allow list when there is one." moves to **OpenCode derived rules**, unchanged.
- "Under an opencode run, where none is composed, they SHALL be composed ..." moves to **OpenCode derived rules**, unchanged.
- "`composeOpenCodeCommand(launch, policy)` and `openCodeConfig(settings, allowedTools, maxWaitMs, shim, checkCommand)` SHALL be exported for ..." moves to **OpenCode composition exports**, unchanged.

### Moved sentences: "Codex network access override"

- "The override document SHALL hold the leaf `codex.networkAccess`, which takes `true`, `false` or null." stays, unchanged.
- "`true` and `false` SHALL be stored as overrides, and `false` SHALL win ..." stays, unchanged.
- "Only null SHALL clear the override, so the value falls back to ..." stays, unchanged.
- "Any other value, the strings `"true"` and `"false"` included, SHALL be refused ..." stays, unchanged.
- "The leaf SHALL be settable through `PUT /v1/config` (`{ codex: { networkAccess ..." moves to **Codex network access surfaces**, with "The leaf SHALL" made explicit as "The leaf `codex.networkAccess` SHALL".
- "The configuration report in `status`, `GET /v1/config`, the start result and `config.json` ..." moves to **Codex network access in the configuration report**, unchanged.
- "The value SHALL apply to launches spawned or claimed after the change; ..." moves to **Codex network access for later launches**, with "The value SHALL apply to launches spawned or claimed after the change;" made explicit as "The value of `codex.networkAccess` SHALL apply to launches spawned or claimed after a change to it;".
- "The key SHALL be accepted and reported under every sandbox, with a ..." moves to **Codex network access under every sandbox and kind**, with "The key SHALL" made explicit as "The key `codex.networkAccess` SHALL".
- "Unlike the runner, model and effort fixed on the launch row at ..." moves to **Codex settings read at command composition**, unchanged.
- "A launch parked before the change and claimed after it SHALL run ..." moves to **Codex settings read at command composition**, with "A launch parked before the change" made explicit as "A launch parked before a change to `codex.networkAccess`".

### Where the new scenarios come from

Each new scenario states behavior the code has at the change's base commit (c4fa94d):

- Runner kind resolution: `test/slice/config.test.ts` ("selects the runner kind, the codex sandbox, and the commit policy, ..."): `config --runner-kind codex` gives source `argument`, and `--clear runnerKind` falls back to `claude-code` from the default; `src/runs/resolve.ts` (no detection layer for the kind).
- Default model per runner kind: `test/runs/resolve.test.ts` ("defaults to claude-code and resolves codex defaults, file values, and no allow list under codex", "resolves the file kind with its defaults, ...").
- Codex runner configuration block: `test/runs/resolve.test.ts` ("defaults to claude-code and resolves codex defaults, ..."), `test/slice/config.test.ts` ("selects codex through the route and a namespaced start argument, ...").
- OpenCode runner configuration block: `test/runs/resolve.test.ts` ("resolves the file kind with its defaults, folds the dotted keys, binds a flat provider/model, and refuses one under another kind").
- Runner kind on the operator surfaces: `test/slice/config.test.ts` ("selects the runner kind, the codex sandbox, and the commit policy, prints the codex leaves with sources, and names both kinds in the usage").
- Effort validated against its kind: `test/slice/config.test.ts` ("selects codex through the route and a namespaced start argument, records the codex leaves, and refuses an unknown kind or an effort the kind lacks"), `test/runs/resolve.test.ts` ("validates the kind and the per-kind effort in the file").
- Task effort selectors against the union: `test/import/mapping.test.ts` ("model: and effort: labels set the selectors, stay in labels, and a bad value is ignored with a note"), `test/graph/load.test.ts` (`effort: huge` refused naming `effort`).
- Effort in place of a missing level: `test/runner/selection.test.ts` ("prepares ultra as max with effortRequested, the opencode default model, and the agent commit policy").
- Kill by launch id across runners: `test/runner/multi.test.ts` ("fans killByLaunchId out to every registered runner").
- Launch kind without a registered runner: `test/runner/multi.test.ts` ("fails a spawn for a kind with no runner, naming the kind").
- Allow list per launch kind: `test/loop/brief.test.ts` ("in a mixed run a codex task gets no Bash rules while a default task keeps the base rules").
- OpenCode commit policy: `test/loop/brief.test.ts` ("commits as the agent by default: no ORCH_COMMIT_POLICY and the daemon does not commit at submit").
- Codex commit policy derived from the sandbox: `test/runs/resolve.test.ts` ("derives runner.codex.commit from the sandbox and defaults runner.claude.commit to agent").
- Commit and sandbox runtime overrides: `test/runs/resolve.test.ts` ("derives runner.codex.commit from the sandbox ..."), `test/slice/config.test.ts` ("selects the runner kind, the codex sandbox, and the commit policy, ...").
- Commit policy fixed on the launch: `test/loop/brief.test.ts` ("fills the derived bash patterns, git first, and no allowedTools or sandbox"), `src/state/store.ts` (`commitPolicyOf`: a row without `commitPolicy` is `agent`).
- Commit policy in the agent environment: `test/loop/brief.test.ts` ("commits as the agent by default: ...", "under runner.opencode.commit: daemon the shim gets the daemon variant and the daemon seals a dirty submit").
- Brief under the agent commit policy: `test/loop/brief.test.ts` ("a claude-code launch and a brief without a runner write the same Definition of done and Workspace sections", "a codex launch under agent commits keeps the git-write sentences and names its sandbox").
- Brief under the daemon commit policy: `test/loop/brief.test.ts` ("a claude-code launch under daemon commits gets the daemon text without a sandbox paragraph", "a codex launch under daemon commits gets the sandbox paragraph and read-only git text").
- Codex brief names its sandbox: `test/loop/brief.test.ts` ("a codex launch under daemon commits gets the sandbox paragraph and read-only git text").
- Codex usage source and unset fields: `test/health/usage.test.ts` ("sums turn.completed usage from a JSONL log with stderr lines interleaved").
- Codex log without usage: `test/health/usage.test.ts` ("yields nothing for a log cut off before turn.completed, a failed turn, or a Claude log").
- OpenCode log read in full: `test/health/usage.test.ts` ("counts a step before a 300 KiB tool-output line", "sums all 200 steps of a 5 MiB log, from a string and streamed from the file").
- OpenCode step usage sums: `test/health/usage.test.ts` ("folds cache reads into input over F1-ask.jsonl", "sums every step of SA-proj2.jsonl and counts the reason "stop" steps as turns").
- OpenCode usage source and turns: `test/health/usage.test.ts` ("sums every step of SA-proj2.jsonl ...", "yields nothing for a Codex log, a log cut before any step_finish, or stderr alone").
- Fixture lines redacted as JSON or text: `test/e2e/opencode.test.ts` ("leaves valid JSON when an address follows an escape, and redacts an upper-case domain"; the describe block runs without opencode).
- Fixture redaction rules: `test/e2e/opencode.test.ts` ("replaces scratch paths, the home directory, the git author name and every email address", "replaces the name on every git identity line").
- OpenCode template slots: `test/runner/opencode.test.ts` ("composes the template with the brief on stdin, the model, and the variant", "drops --pure under pure: false and --variant when effort is unset", "the shell hands -m one word and the brief to stdin").
- OpenCode config in the launch environment: `test/runner/opencode.test.ts` ("passes the per-launch config in OPENCODE_CONFIG_CONTENT, the brief on stdin, and the token only in the environment").
- OpenCode data and config isolation: `test/runner/opencode.test.ts` ("passes the per-launch config in OPENCODE_CONFIG_CONTENT, ..." with the defaults, "follows toolTimeoutMs, dataDir: launch, and ignoreUserConfig").
- OpenCode per-launch config content: `test/runner/opencode.test.ts` ("carries the shim, the timeout, snapshots off, sharing off, and the derived ruleset").
- OpenCode MCP call timeout: `test/runner/opencode.test.ts` ("carries the shim, the timeout, ...": `maxWaitMs` 90500 gives 150500).
- OpenCode MCP timeout key: `test/runner/opencode.test.ts` ("passes the per-launch config in OPENCODE_CONFIG_CONTENT, ...": no `mcp.timeout`; "a shim that never started is mcpStartupFailed although the turn completed": D4.jsonl completes its turn).
- OpenCode permission ruleset: `test/runner/opencode.test.ts` ("carries the shim, the timeout, snapshots off, sharing off, and the derived ruleset").
- OpenCode deny catch-alls: `test/runner/opencode.test.ts` ("carries the shim, ...": no `ask` in the ruleset; "a deny refusal the agent continued past is not a failure"; "an auto-rejected ask ends the run and is permissionDenied naming the command").
- OpenCode catch-all first: `test/runner/opencode.test.ts` ("carries the shim, ...": the first key of the permission map and of the bash map is `*`).
- Derived rules as bash patterns: `test/runner/opencode.test.ts` ("maps derived rules to bash patterns").
- Glob-only patterns kept out of the ruleset: `test/runner/opencode.test.ts` ("keeps the bash catch-all denied whatever the check command splits into").
- OpenCode command node matching: `test/runner/opencode.test.ts` ("keeps redirections and brace groups whole", "splits subshells, a lone ampersand and escaped quotes the way OpenCode sees the commands").
- OpenCode chain parts matched alone: `test/runner/opencode.test.ts` ("splits a check command into one exact pattern per command of the chain", "carries the shim, ...": with no derived rules the bash map is `{ "*": "deny", "git *": "allow" }`).
- Check-command splitting: `test/runner/opencode.test.ts` ("splits a check command into one exact pattern per command of the chain"; "passes the per-launch config in OPENCODE_CONFIG_CONTENT, ...": the check command `node --test` comes from the launch's brief.json).
- Backslash escapes in the check command: `test/runner/opencode.test.ts` ("splits subshells, a lone ampersand and escaped quotes the way OpenCode sees the commands").
- Redirection operators stay in their command: `test/runner/opencode.test.ts` ("keeps redirections and brace groups whole").
- Substitutions stay whole in their command: `test/runner/opencode.test.ts` ("keeps a substitution whole in its command and gives its inner commands patterns of their own").
- Inner commands of a substitution: `test/runner/opencode.test.ts` ("keeps a substitution whole in its command and gives its inner commands patterns of their own").
- Brace group words dropped: `test/runner/opencode.test.ts` ("keeps redirections and brace groups whole").
- Heredoc bodies and comments dropped: `test/runner/opencode.test.ts` ("drops heredoc bodies and comments").
- Glob-only check-command patterns: `test/runner/opencode.test.ts` ("never returns a pattern made only of glob characters").
- OpenCode glob characters: `test/runner/opencode.test.ts` ("copies glob characters verbatim, giving a wildcard pattern").
- No escape for OpenCode glob characters: `test/runner/opencode.test.ts` ("copies glob characters verbatim, giving a wildcard pattern"; its comment cites X-glob-escape.jsonl).
- Check-command parts allowed verbatim: `test/runner/opencode.test.ts` ("copies glob characters verbatim, giving a wildcard pattern").
- OpenCode derived rules: `test/loop/brief.test.ts` ("fills the derived bash patterns, git first, and no allowedTools or sandbox"), `src/main.ts` (the OpenCode runner's `allowedTools`: the composed list, else `composeAllowedTools` from the toolchain, `deriveTools`, the file rules and the argument rules).
- OpenCode composition exports: `test/host/work-loop.test.ts` ("is the command the OpenCode runner spawns, with the brief swapped for the loop prompt"), `src/index.ts` (exports `composeOpenCodeCommand` and `openCodeConfig`).
- Codex network access surfaces: `test/runs/resolve.test.ts` ("parses --set codex.networkAccess as exactly true or false, and keeps the JSON-object form", "folds the flat tool argument under codex whatever the kind, ..."), `test/slice/config.test.ts` ("codex.networkAccess is set through the route, set and cleared through config --set and --clear, ...").
- Codex network access in the configuration report: `test/runs/resolve.test.ts` ("resolves an argument over the file, and an override of false is an argument").
- Codex network access for later launches: `test/slice/codex.test.ts` ("codex.networkAccess set before the first launch reaches the command line").
- Codex network access under every sandbox and kind: `test/slice/codex.test.ts` ("codex.networkAccess is accepted under read-only and the flag is still passed"), `test/runs/resolve.test.ts` ("folds the flat tool argument under codex whatever the kind, ...").
- Codex settings read at command composition: `test/slice/codex-work.test.ts` ("a codex claim made after codex.networkAccess is set carries it, though the launch was parked before"), `test/slice/codex.test.ts` ("codex.networkAccess is accepted under read-only ...": the runtime sandbox reaches the spawned command).

## Capabilities

### New Capabilities

### Modified Capabilities

- `worker-runners`: nine long requirements cut to one behavior each; 57 requirements added for the moved behaviors. "Codex runner command composition" is not touched.

## Impact

Spec text only. No code, test or other capability changes.
