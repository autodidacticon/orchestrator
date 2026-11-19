## MODIFIED Requirements

### Requirement: Runner kinds and defaults
The configuration SHALL carry `runner.kind`, one of `claude-code`, `codex`, and `opencode`, defaulting to `claude-code`, and one block per kind: `runner.claude`, `runner.codex`, and `runner.opencode`. A value outside the kinds SHALL be refused at configuration time naming `runner.kind` in the file and `runnerKind` as an argument.

#### Scenario: Claude Code by default
- **WHEN** the daemon starts with no file and no overrides
- **THEN** `config.runnerKind` is `{ value: "claude-code", source: "default" }` and `config.model` is `{ value: "claude-opus-5-5", source: "default", applied: true }`

#### Scenario: The file selects Codex
- **WHEN** `orchestrator.yaml` sets `runner.kind: codex` and nothing else under `runner`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "file" }`, `config.model` is `{ value: "gpt-6-astra", source: "default", applied: true }`, `config.effort` is `{ value: "medium", source: "default", applied: true }`, and `config.codex.sandbox` is `{ value: "workspace-write", source: "default" }`

#### Scenario: The file sets the Codex model
- **WHEN** the file sets `runner.kind: codex` and `runner.codex.model: gpt-6-pro`
- **THEN** `config.model` is `{ value: "gpt-6-pro", source: "file", applied: true }`

#### Scenario: The file selects OpenCode
- **WHEN** `orchestrator.yaml` sets `runner.kind: opencode` and nothing else under `runner`
- **THEN** `config.model` is `{ value: "anthropic/claude-opus-5-5", source: "default", applied: true }`, and `config.opencode` carries `commit` `{ value: "agent", source: "default" }`, `permission` `{ value: "derived", source: "default" }`, and `dataDir` `{ value: "shared", source: "default" }`

#### Scenario: Selected at runtime
- **WHEN** `PUT /v1/config` carries `runnerKind: "codex"` on a running daemon
- **THEN** the response is 200, `config.json` shows `runnerKind` `{ value: "codex", source: "argument" }` with the `codex` leaves, and launches prepared afterwards resolve the Codex model

#### Scenario: Selected from the operator surfaces
- **WHEN** the operator runs `orchestrator-ctl config --runner-kind codex`, or calls the MCP `configure` tool with `runnerKind: "codex"`
- **THEN** `config.runnerKind` is `{ value: "codex", source: "argument" }` in either case

#### Scenario: Unknown kind refused
- **WHEN** `PUT /v1/config` carries `runnerKind: "cursor"`, or the file sets `runner.kind: cursor`
- **THEN** the route answers 400 naming `runnerKind`, and the file fails to load naming `runner.kind`

#### Scenario: Each kind keeps its own model
- **WHEN** the operator sets `runnerKind` to `codex` and `model` to `gpt-6-astra` in one patch, then clears `runnerKind`
- **THEN** under `codex` the model is `gpt-6-astra` with source `argument`, and after the clear the model is the Claude Code default with source `default`

### Requirement: Per-kind effort sets
Each runner kind SHALL accept its own set of effort levels: `claude-code` accepts `low`, `medium`, `high`, `xhigh`, and `max`; `codex` accepts those and `ultra`; `opencode` accepts the `claude-code` set and passes the level through as `--variant`, which variants a model lists being the CLI's to decide. The set SHALL be a superset check: a model of the kind may accept fewer levels, and the CLI remains the final validator.

#### Scenario: Ultra refused for Claude Code
- **WHEN** the kind in force is `claude-code` and `PUT /v1/config` carries `effort: "ultra"`
- **THEN** the response is 400 naming `effort` and `claude-code`, and nothing changes

#### Scenario: Ultra accepted for Codex
- **WHEN** the kind in force is `codex` and `PUT /v1/config` carries `effort: "ultra"`
- **THEN** the response is 200 and `config.effort` is `{ value: "ultra", source: "argument", applied: true }`

#### Scenario: The file is checked per kind
- **WHEN** the file sets `runner.claude.effort: ultra`
- **THEN** the file fails to load; `runner.codex.effort: ultra` loads

#### Scenario: Ultra prepared as max for OpenCode
- **WHEN** the kind in force is `opencode` and a task declares `effort: ultra`
- **THEN** its launch is prepared with `effort: max` and `launch.created` carries `effortRequested: ultra`

#### Scenario: Task selectors use the union
- **WHEN** a node declares `effort: ultra`, or an imported issue carries the label `effort:ultra`
- **THEN** the node's payload carries `effort: ultra`; `effort: huge` still fails graph validation naming the node and `effort`, and the label `effort:huge` is ignored

### Requirement: Runner dispatch by launch kind
The daemon SHALL hold one agent runner per runner kind behind a single dispatching runner, and SHALL route `spawn`, `alive`, `liveness`, `reap`, and `readUsage` for a launch to the runner of the kind fixed on its row, so a launch observed after a restart reaches the runner and the usage parser it was prepared for. A row without a kind SHALL be treated as `claude-code`.

#### Scenario: Calls follow the row
- **WHEN** a `claude-code` launch and a `codex` launch are spawned, observed, reaped, and their usage read
- **THEN** each call reaches the runner of the launch's own kind and never the other

#### Scenario: Row without a kind
- **WHEN** a launch row written before the kind was recorded is spawned or its usage read
- **THEN** the `claude-code` runner handles it

#### Scenario: Usage per kind
- **WHEN** a `claude-code` launch submits and a `codex` launch exits in the same run
- **THEN** each launch row records the usage its own kind's runner reads

#### Scenario: Kill by id reaches every runner
- **WHEN** recovery kills a launch by id
- **THEN** every registered runner is asked to kill processes of that id

#### Scenario: No runner for the kind
- **WHEN** a `codex` launch is spawned while no `codex` runner is registered
- **THEN** the spawn fails with an error naming `codex`

#### Scenario: Task-level selector mixes fleets
- **WHEN** the run kind is `claude-code`, a run template has `{allowedTools}`, task C declares `runner: codex`, and task P declares no runner
- **THEN** C's launch is spawned by the `codex` runner with a brief input carrying `runner.kind: "codex"` and no allow list, and P's launch is spawned by the `claude-code` runner with the allow list

### Requirement: Sandbox and commit policy
The configuration SHALL carry `runner.codex.sandbox` with one of `read-only`, `workspace-write`, or `danger-full-access`, defaulting to `workspace-write`. Each runner kind SHALL carry a commit policy, `runner.<kind>.commit`, with one of `agent` (the agent commits before it submits) or `daemon` (the daemon commits what the agent left when it submits). `runner.claude.commit` SHALL default to `agent`.

#### Scenario: Claude Code commits by default
- **WHEN** a run uses the default configuration
- **THEN** `runner.claude.commit` resolves to `agent` and a claude-code launch is prepared with `commitPolicy: agent`

#### Scenario: Codex under the default sandbox
- **WHEN** a run sets `runner.kind: codex` and sets neither `runner.codex.sandbox` nor `runner.codex.commit`
- **THEN** the sandbox resolves to `workspace-write`, `runner.codex.commit` resolves to `daemon`, and the launch is prepared with `commitPolicy: daemon`

#### Scenario: Codex with full access
- **WHEN** `runner.codex.sandbox` is `danger-full-access` and `runner.codex.commit` is unset
- **THEN** `runner.codex.commit` resolves to `agent`

#### Scenario: Daemon commits chosen for Claude Code
- **WHEN** the operator sets `claude.commit: daemon` at runtime
- **THEN** claude-code launches prepared afterwards carry `commitPolicy: daemon` and launches already prepared keep theirs

#### Scenario: Codex brief under each policy
- **WHEN** a brief is composed for a `codex` launch under `daemon` with `workspace-write`, and another under `agent` with `danger-full-access`
- **THEN** both name their sandbox; the first says the orchestrator commits uncommitted changes and contains none of "commit and resubmit", "You may rebase", "Rebase that branch or start over", "squash the work-in-progress commit", or "commit the delta"; the second contains all five

#### Scenario: OpenCode commits as the agent by default
- **WHEN** an `opencode` launch is prepared and `runner.opencode.commit` is unset
- **THEN** the policy is `agent`, `ORCH_COMMIT_POLICY` is not set, the brief tells the agent to commit and resubmit, and the daemon does not commit at submit

#### Scenario: Daemon commits chosen for OpenCode
- **WHEN** `runner.opencode.commit` is `daemon`
- **THEN** the launch carries `commitPolicy: daemon`, the agent environment sets `ORCH_COMMIT_POLICY=daemon` (so the shim's report tool takes its daemon-commits wording), and the daemon commits a dirty worktree when it accepts the submit

#### Scenario: Daemon commits an OpenCode submit in the real-git slice
- **WHEN** an `opencode` launch under `runner.opencode.commit: daemon` runs through the OpenCode runner and its default template, with a fake `opencode` on PATH that submits a dirty worktree
- **THEN** the task reaches `done`, the launch branch head is a commit by `orchestrator` holding only the agent's file with the report summary as its message, `sealedSha` is that head, and `agent.report` carries `committedByOrchestrator: true`

### Requirement: Codex usage parsing
`CodexRunner.readUsage` SHALL read the launch log. The parser SHALL:
- read at most the last 256 KiB, line by line;
- `JSON.parse` each line and skip lines that fail;
- sum `usage` over every `turn.completed` line into `tokens`: `input_tokens` to `input` (which already counts cached input), `cached_input_tokens` to `cachedInput`, `cache_write_input_tokens` to `cacheWriteInput`, `output_tokens` to `output`, and `reasoning_output_tokens` to `reasoningOutput`.

#### Scenario: Probe log with stderr interleaved
- **WHEN** the log holds the probe's JSONL with stderr lines between them
- **THEN** the usage is `tokens { input: 40361, cachedInput: 32128, cacheWriteInput: 0, output: 260, reasoningOutput: 0 }` with `source: 'codex'`

#### Scenario: Two turns sum
- **WHEN** the log holds two `turn.completed` lines
- **THEN** each token field is their sum

#### Scenario: No turn.completed
- **WHEN** the log was cut off before `turn.completed`, or is a Claude log
- **THEN** no usage is read

### Requirement: OpenCode usage parsing
`OpenCodeRunner.readUsage` SHALL read the launch log. The parser SHALL:
- skip a line of more than 64 KiB (65536 bytes of UTF-8) without parsing its body: `step_finish` lines are a few hundred bytes, and the long lines are tool output. The cap SHALL be measured in UTF-8 bytes both when the log is parsed from a string and when it is streamed from the file, so the two paths count the same lines;
- `JSON.parse` each line and skip lines that fail;

#### Scenario: Probe log
- **WHEN** the log is test/fixtures/opencode/events/F1-ask.jsonl
- **THEN** the usage is `tokens { input: 14533, cachedInput: 10240, cacheWriteInput: 0, output: 25, reasoningOutput: 17 }`, `costUsd: 0`, `source: 'opencode'`

#### Scenario: Several steps
- **WHEN** the log holds several `step_finish` lines, one with `reason: "stop"`
- **THEN** each field is their sum and `turns` is 1

#### Scenario: A step before a large tool output
- **WHEN** the log holds a `step_finish` with input 1000 and cost 1, then a 300 KiB `tool_use` line, then a `step_finish` with input 5 and cost 1
- **THEN** the usage sums both steps: the input counts 1005 plus their cache reads and `costUsd` is 2

#### Scenario: Long log
- **WHEN** the log is 5 MiB with 200 `step_finish` lines between large tool outputs and stderr lines
- **THEN** each field is the exact sum of the 200 steps

#### Scenario: Line cap boundary
- **WHEN** the log holds a `step_finish` line of exactly 65536 UTF-8 bytes, or one of 65537 bytes, padded with ASCII or with multi-byte characters
- **THEN** the line of 65536 bytes is counted and the line of 65537 bytes is skipped, whether the log is parsed from a string or streamed from the file, even when the longer line has fewer than 65536 UTF-16 code units

#### Scenario: No step_finish
- **WHEN** the log was cut before any `step_finish`, or is a Codex log
- **THEN** no usage is read

### Requirement: OpenCode e2e fixture recording
The opt-in OpenCode e2e (test/e2e/opencode.test.ts) SHALL write fixtures only under `ORCH_E2E_OPENCODE_RECORD=1`, copying each task's first launch's JSONL events to test/fixtures/opencode/e2e-<task>.jsonl (e2e-<case>-<task>.jsonl for other cases). A committed OpenCode fixture SHALL carry no email address other than an `example.invalid` one.

#### Scenario: A git author line is redacted
- **WHEN** a recorded event holds the output of `git show --stat HEAD` with `Author: Jane Q. Doe <jane.doe+git@mail.example.com>` and a `Co-Authored-By: Bot <noreply@anthropic.com>` trailer
- **THEN** the fixture holds `Author: Fixture Author <author@example.invalid>` and `Co-Authored-By: Fixture Author <author@example.invalid>`, and neither name nor either address

#### Scenario: Every identity line is redacted
- **WHEN** a recorded event holds `git show --format=fuller` output with `Commit:` and `Committer:` lines and `Signed-off-by:` and `Co-Authored-By:` trailers
- **THEN** the name on each of those lines is `Fixture Author`, and the `AuthorDate:` and `CommitDate:` lines are unchanged

#### Scenario: An address after an escape
- **WHEN** a recorded JSON line holds an address right after a `\n`, `\t`, `<` or `<` in a string, or an address with an upper-case domain such as `jane@X.COM`
- **THEN** the redacted line parses as JSON, each address is `author@example.invalid`, and the character before it is unchanged

#### Scenario: Scratch paths and the home directory are redacted
- **WHEN** a recorded event names a path under the run directory or the home directory
- **THEN** the fixture names it under `<scratch>` or `~`

#### Scenario: Committed fixtures carry no personal address
- **WHEN** `git grep -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- test/fixtures/opencode` runs
- **THEN** every match is an `example.invalid` address

### Requirement: OpenCode runner command composition
The OpenCode runner SHALL spawn `DEFAULT_OPENCODE_COMMAND`, or `runner.opencode.command` when it is set:

`opencode run --format json {pure} --print-logs --log-level WARN -m {model} {variant} < {brief}`

The brief on stdin SHALL be the whole message; the template SHALL have no positional message and no `{allowedTools}` slot. stdin SHALL always be redirected: a run whose stdin stays open hangs after `message=init`.

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

### Requirement: Codex network access override
The override document SHALL hold the leaf `codex.networkAccess`, which takes `true`, `false` or null. `true` and `false` SHALL be stored as overrides, and `false` SHALL win over a file that sets `runner.codex.networkAccess: true`. Only null SHALL clear the override, so the value falls back to the file, else to unset. Any other value, the strings `"true"` and `"false"` included, SHALL be refused with 400 naming `codex.networkAccess`, and nothing of the patch SHALL be stored.

#### Scenario: Set to true
- **WHEN** `PUT /v1/config { codex: { networkAccess: true } }` is sent before the first launch of a codex run
- **THEN** the answer is 200 with `applied: ['codex']` and `config.codex.networkAccess` is `{ value: true, source: 'argument' }`
- **AND** the command line of the next spawned launch holds `-c sandbox_workspace_write.network_access=true`

#### Scenario: File true, override false
- **WHEN** `orchestrator.yaml` sets `runner.codex.networkAccess: true` and the override `{ codex: { networkAccess: false } }` is stored
- **THEN** `config.codex.networkAccess` is `{ value: false, source: 'argument' }`
- **AND** the command line of a launch spawned afterwards holds no `sandbox_workspace_write.network_access` override

#### Scenario: Clear
- **WHEN** the stored document is `{ codex: { sandbox: 'read-only', networkAccess: true } }` and `{ codex: { networkAccess: null } }` is applied
- **THEN** the stored document is `{ codex: { sandbox: 'read-only' } }`
- **AND** the leaf falls back to the file, else to `{ value: undefined, source: 'default' }`

#### Scenario: A non-boolean is refused
- **WHEN** `PUT /v1/config { codex: { networkAccess: 'true' } }` is sent, or `orchestrator-ctl config --set codex.networkAccess=maybe` is run
- **THEN** the route answers 400 with `key: 'codex.networkAccess'`, or the CLI exits with a usage error that names `codex.networkAccess`
- **AND** the stored document is unchanged

#### Scenario: A running launch keeps its command line
- **WHEN** a Codex launch is running and `codex.networkAccess` is changed
- **THEN** the running process keeps the command line it was spawned with
- **AND** only launches spawned or claimed after the change see the new value

#### Scenario: A launch parked before the change and claimed after it
- **WHEN** a Codex launch is claimable in pull mode, `codex.networkAccess` is set to `true`, and the launch is then claimed
- **THEN** the claim's `codex.settings.networkAccess` is `true`
- **AND** the launch keeps the brief of its last preparation

## ADDED Requirements

### Requirement: Runner kind resolution
`runner.kind` SHALL resolve through the configuration layers as the key `runnerKind`: an argument (a `start` argument, a `--set` flag, or a runtime override) beats the file, which beats the default; it SHALL NOT be detected, pinned, or start-only, and a change SHALL apply to launches prepared afterwards.

#### Scenario: Cleared kind falls back to the default
- **WHEN** the operator sets `runnerKind` to `codex` with `orchestrator-ctl config --runner-kind codex` and later runs `orchestrator-ctl config --clear runnerKind`
- **THEN** `config.runnerKind` is first `{ value: "codex", source: "argument" }` and then `{ value: "claude-code", source: "default" }`

### Requirement: Default model per runner kind
Each kind SHALL have its own default model: `claude-opus-5-5` for `claude-code`, `gpt-6-astra` for `codex`, and `anthropic/claude-opus-5-5` for `opencode` (the Claude Code default reached through the user's OpenCode Anthropic login); all default to effort `medium`. The run default `model` and `effort` SHALL be those of the kind in force, so a run under `codex` never resolves a Claude model.

#### Scenario: Each kind's default model
- **WHEN** the daemon resolves its configuration with no file and no overrides, and again with a file that sets only `runner.kind: opencode`
- **THEN** the first reports `config.model` `{ value: "claude-opus-5-5", source: "default", applied: true }` and `config.codex.model` `{ value: "gpt-6-astra", source: "default" }`, and the second reports `config.model` `{ value: "anthropic/claude-opus-5-5", source: "default", applied: true }`

### Requirement: Codex runner configuration block
`runner.codex` SHALL carry `command` (unset by default, so the runner's built-in template applies), `model`, `effort`, `sandbox` (`read-only`, `workspace-write`, or `danger-full-access`, default `workspace-write`), `commit` (`agent` or `daemon`, unset by default), `networkAccess` (unset by default), `ignoreUserConfig` (default true), `ephemeral` (default true), `mcpApproval`, `toolTimeoutSec`, and `startupTimeoutSec`; the semantics of the policy keys belong to the Codex runner.

#### Scenario: Codex block defaults
- **WHEN** the file sets `runner.kind: codex` and nothing else under `runner`
- **THEN** `config.codex` reports `command` `{ value: undefined, source: "default" }`, `sandbox` `{ value: "workspace-write", source: "default" }`, `ignoreUserConfig` `{ value: true, source: "default" }` and `ephemeral` `{ value: true, source: "default" }`

### Requirement: OpenCode runner configuration block
`runner.opencode` SHALL carry `command` (unset by default), `model` (a `provider/model` id), `effort`, `commit` (`agent` or `daemon`, default `agent`), `permission` (`derived` or `allow`, default `derived`), `dataDir` (`shared` or `launch`, default `shared`), `ignoreUserConfig` (default false), `pure` (default true), and `snapshots` (default false); the semantics of the policy keys belong to the OpenCode runner.

#### Scenario: OpenCode keys set at start
- **WHEN** the file sets `runner.kind: opencode` and the start arguments are `--set opencode.model=opencode/big-pickle --set opencode.dataDir=launch`
- **THEN** `runner.opencode` holds `model: opencode/big-pickle`, `dataDir: launch` and `permission: derived`, and `config.opencode.dataDir` is `{ value: "launch", source: "argument" }`

### Requirement: Runner kind on the operator surfaces
Every operator surface SHALL expose the kind and the per-kind keys. The operator surfaces are `orchestrator-ctl start --set runnerKind=... --set codex.<leaf>=...`, `orchestrator-ctl config --runner-kind --sandbox --commit`, the MCP `start` and `configure` tools (`runnerKind`, `codex`, `sandbox`, `commit`), and `PUT /v1/config`. Each surface that names a default SHALL name both kinds' defaults.

#### Scenario: The usage names the kind keys and both defaults
- **WHEN** the operator runs `orchestrator-ctl --help`
- **THEN** the usage names `--runner-kind`, `--sandbox`, `--commit`, `runnerKind=claude-code|codex`, `claude-opus-5-5 at medium` and `gpt-6-astra at medium`

### Requirement: Effort validated against its kind
`runner.claude.effort`, `runner.codex.effort`, and `runner.opencode.effort` in the file, and an `effort` argument, SHALL be validated against the set of their kind, and a refusal SHALL name `effort` and the kind.

#### Scenario: An effort outside the kind's set
- **WHEN** the kind in force is `codex` and `PUT /v1/config` carries `effort: "huge"`
- **THEN** the response is 400 with `key: "effort"` and an error naming `codex`

### Requirement: Task effort selectors against the union
A task's `effort` selector, in the graph file or from an import label, SHALL be validated against the union of every kind's set, since the kind a task runs under is decided when its launch is prepared.

#### Scenario: Ultra label under the default kind
- **WHEN** an imported issue carries the label `effort:ultra` and another carries `effort:huge`
- **THEN** the first node carries `effort: ultra` whatever kind the run uses, and the second carries no `effort` and its label is listed as ignored

### Requirement: Effort in place of a missing level
Each kind SHALL define the level it runs at in place of one it lacks (`ultra` as `max` for `claude-code` and for `opencode`); the moment that mapping applies belongs to launch preparation.

#### Scenario: OpenCode selection for an ultra task
- **WHEN** the kind in force is `opencode` and task T1 declares `effort: ultra`
- **THEN** the selection for T1 is `{ runner: "opencode", model: "anthropic/claude-opus-5-5", effort: "max", effortRequested: "ultra" }`

### Requirement: Kill by launch id across runners
Killing by launch id, where only the id is known, SHALL be asked of every registered runner.

#### Scenario: Both runners asked
- **WHEN** a `claude-code` and a `codex` runner are registered and launch `b`, spawned by the `codex` runner, is killed by id
- **THEN** both runners are asked to kill `b`, `b` is no longer alive, and the `claude-code` launch `a` is still alive

### Requirement: Launch kind without a registered runner
A launch whose kind has no registered runner SHALL fail at spawn with an error naming the kind; its liveness SHALL be `unknown` and it SHALL have no usage.

#### Scenario: Nothing to observe for an unregistered kind
- **WHEN** only a `claude-code` runner is registered and a `codex` launch is spawned, observed and its usage read
- **THEN** the spawn rejects with "no runner is registered for kind codex", its liveness is `unknown`, and its usage is undefined

### Requirement: Allow list per launch kind
The allow list SHALL be given only to the brief of a `claude-code` launch. Because the kind on the row comes from the task's `runner` selector when it has one (see model-selection "Task selectors"), one run MAY hold launches of both kinds at once.

#### Scenario: Mixed run briefs
- **WHEN** task C declares `runner: codex`, task P declares no runner, and both are prepared in one run of kind `claude-code`
- **THEN** C's brief input has `runner.kind: "codex"` and no `allowedTools`, its brief does not say "Bash rules are in force", and P's brief input has `runner.kind: "claude-code"` with the base rules

### Requirement: OpenCode commit policy
OpenCode has no sandbox, only per-tool permission rules, so nothing stands between its agent and git: `runner.opencode.commit` SHALL default to `agent` and SHALL NOT be derived.

#### Scenario: OpenCode under the default Codex sandbox
- **WHEN** `runner.opencode.commit` is unset and the Codex sandbox is the default `workspace-write`, under which the Codex policy derives to `daemon`
- **THEN** the OpenCode commit policy is `agent` and an `opencode` launch is prepared with `commitPolicy: agent`

### Requirement: Codex commit policy derived from the sandbox
When `runner.codex.commit` is unset it SHALL be derived from the sandbox in force: `daemon`, or `agent` when the sandbox is `danger-full-access`. The reason is that under `workspace-write` Codex cannot run `git add` or `git commit` in a linked worktree: the index lock under `<repo>/.git/worktrees/<wt>/` is refused with `Operation not permitted`, and Codex keeps `.git` and the resolved gitdir read-only even inside writable roots.

#### Scenario: Derived Codex policy
- **WHEN** the file sets neither `runner.codex.sandbox` nor `runner.codex.commit`, and again when it sets only `runner.codex.sandbox: danger-full-access`
- **THEN** `runner.codex.commit` resolves to `daemon` the first time and to `agent` the second, and `runner.claude.commit` is `agent` both times

### Requirement: Commit and sandbox runtime overrides
`codex.sandbox`, `codex.commit`, `claude.commit`, and `opencode.commit` SHALL be accepted as runtime overrides that apply to launches prepared afterwards. A derived value moves with a sandbox override, and an explicit `commit` wins over the derivation.

#### Scenario: Derivation follows a sandbox override
- **WHEN** the override document sets `codex.sandbox: danger-full-access` and `codex.commit` is set nowhere
- **THEN** `codex.commit` is `{ value: "agent", source: "default" }`

#### Scenario: Explicit commit wins
- **WHEN** the file sets `runner.codex.sandbox: danger-full-access` and `runner.codex.commit: daemon`
- **THEN** `codex.commit` is `{ value: "daemon", source: "file" }`

### Requirement: Commit policy fixed on the launch
The commit policy SHALL be resolved from the launch's runner kind when the launch is prepared, recorded on the launch row as `commitPolicy` and in `launch.created`, and passed to the brief input with the sandbox of a `codex` launch and the permission mode (and derived bash patterns) of an `opencode` launch. An `opencode` launch has no sandbox in its brief input. A launch row without a commit policy SHALL be treated as `agent`.

#### Scenario: OpenCode brief input
- **WHEN** an `opencode` launch is prepared under `permission: derived` with the default commit policy
- **THEN** the launch row has `commitPolicy: agent` and its brief input's `runner` is `{ kind: "opencode", commitPolicy: "agent", permission: { mode: "derived", bashPatterns } }`, with no `sandbox`

#### Scenario: Row without a policy
- **WHEN** a launch row written before the policy was recorded is read
- **THEN** its commit policy is `agent`

### Requirement: Commit policy in the agent environment
Under `daemon` the daemon SHALL set `ORCH_COMMIT_POLICY=daemon` in the agent's environment and in the MCP façade's.

#### Scenario: Environment under each policy
- **WHEN** an `opencode` launch is prepared under `agent`, and another under `runner.opencode.commit: daemon`
- **THEN** the first launch's agent environment has no `ORCH_COMMIT_POLICY`, and the second's has `ORCH_COMMIT_POLICY=daemon`

### Requirement: Brief under the agent commit policy
The brief SHALL follow the commit policy. Under `agent` the brief SHALL tell the agent to commit all work and resubmit after a 409. The brief under `agent` SHALL allow rebasing the launch branch onto the integration head, and tell the agent to rebase a conflicted branch, merge or cherry-pick an interrupted one and squash its work-in-progress commit, and commit a revision delta.

#### Scenario: Claude Code brief under agent
- **WHEN** a brief is composed for a `claude-code` launch under `agent`
- **THEN** it contains "commit and resubmit", "You may rebase", "Rebase that branch or start over", "squash the work-in-progress commit" and "commit the delta"

### Requirement: Brief under the daemon commit policy
Under `daemon` the brief SHALL tell the agent to leave its changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. The brief under `daemon` SHALL say the orchestrator rebases the branch at verification, and tell the agent to inspect a prior branch with `git show`/`git diff` and reapply the changes as file edits. Under `daemon` none of the agent-side git-write instructions SHALL appear.

#### Scenario: Claude Code brief under daemon
- **WHEN** a brief is composed for a `claude-code` launch under `daemon`
- **THEN** it says "the orchestrator commits what is uncommitted when it accepts your report", names no Codex sandbox, and contains none of "commit and resubmit", "You may rebase", "Rebase that branch or start over", "squash the work-in-progress commit" or "commit the delta"

### Requirement: Codex brief names its sandbox
A `codex` launch's brief SHALL also name its sandbox mode and tell the agent that a refused command is not approved at runtime and is to be asked for with a `needsAccess` question rather than retried.

#### Scenario: Refused command under workspace-write
- **WHEN** a brief is composed for a `codex` launch under `workspace-write`
- **THEN** it says "You run under the Codex sandbox `workspace-write` with approvals disabled" and that a refused command "will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command."

### Requirement: Codex usage source and unset fields
The usage SHALL have `source: 'codex'`. `costUsd`, `durationMs`, and `turns` SHALL be left unset: one exec is one Codex turn, which is not comparable with Claude's `num_turns`.

#### Scenario: No cost, duration or turns
- **WHEN** the Codex parser reads the probe's JSONL with stderr lines interleaved
- **THEN** the usage has `source: 'codex'` and no `costUsd`, `durationMs` or `turns` property

### Requirement: Codex log without usage
A log without a `turn.completed` that has input and output counts SHALL yield no usage.

#### Scenario: Failed turn or broken line
- **WHEN** the Codex log holds a failed turn and no `turn.completed` (C-events.jsonl), or only a `turn.completed` line that fails to parse, or is empty
- **THEN** no usage is read

### Requirement: OpenCode log read in full
The parser of `OpenCodeRunner.readUsage` SHALL:
- read the whole log, line by line, streaming the file so memory stays bounded by the read chunk and the line cap, not the log size. OpenCode reports usage per step, not as a running total, so a step dropped from the read is usage lost; the log also carries full tool outputs and WARN-level stderr, so a tail window would drop the early steps of any task that reads large files;

#### Scenario: Streamed and string reads agree
- **WHEN** a 5 MiB log with 200 `step_finish` lines between large tool outputs is parsed from a string and also streamed from the file
- **THEN** both reads count all 200 steps and give the same usage

### Requirement: OpenCode step usage sums
The parser of `OpenCodeRunner.readUsage` SHALL:
- for every line with `type: "step_finish"`, add `part.tokens.input + part.tokens.cache.read` to `input` (opencode's `input` excludes cache reads), `cache.read` to `cachedInput`, `cache.write` to `cacheWriteInput`, `output` to `output`, `reasoning` to `reasoningOutput`, and `part.cost` to `costUsd`.

#### Scenario: Cache reads folded into input
- **WHEN** the log is test/fixtures/opencode/events/SA-proj2.jsonl, six steps with `input` 9057 and cache reads 79360 in all
- **THEN** `tokens.input` is 9057 + 79360, `cachedInput` is 79360, and `costUsd` is the sum of the steps' `part.cost`, 0

### Requirement: OpenCode usage source and turns
The usage SHALL have `source: 'opencode'`, `turns` the number of `step_finish` lines with `reason: "stop"`, and no `durationMs`. A log without a `step_finish` that has input and output counts SHALL yield no usage.

#### Scenario: Turns count the stop steps
- **WHEN** the log is test/fixtures/opencode/events/SA-proj2.jsonl, whose six steps include one with `reason: "stop"`
- **THEN** the usage has `source: 'opencode'`, `turns: 1`, and no `durationMs`

### Requirement: Fixture lines redacted as JSON or text
Before writing, the recorder SHALL redact each line: a line that parses as JSON SHALL be redacted on its decoded string values and keys and written back with `JSON.stringify`, so a pattern never consumes part of a JSON escape and the line stays valid JSON; any other line SHALL be redacted as text.

#### Scenario: Escaped address in a JSON line
- **WHEN** a recorded line is `{"e":"x\u003cjane@mail.com\u003e"}`
- **THEN** the redacted line parses as JSON to `{ e: "x<author@example.invalid>" }`

### Requirement: Fixture redaction rules
In each string the recorder redacts, every scratch path (the run directory, with and without a leading `/private`) SHALL become `<scratch>`, the home directory SHALL become `~`, the name on every git identity line (`Author:`, `Commit:`, `Committer:`, `Signed-off-by:`, `Co-Authored-By:` or `Co-authored-by:`, at the start of a line after optional indentation) SHALL become `Fixture Author`, and every email address, whatever the case of its domain, SHALL become `author@example.invalid`.

#### Scenario: Paths, names and addresses
- **WHEN** a recorded JSON line holds `workdir: "/private/tmp/orch-x/repo"`, `home: "/Users/jane/.config"` and an `Author: Jane Q. Doe <jane.doe+git@mail.example.com>` line, with the run directory `/tmp/orch-x` and the home directory `/Users/jane`
- **THEN** the fixture holds `workdir: "<scratch>/repo"`, `home: "~/.config"` and `Author: Fixture Author <author@example.invalid>`

### Requirement: OpenCode template slots
At every spawn the OpenCode runner SHALL fill:
- `{pure}` with `--pure` when `runner.opencode.pure` is true (the default), and otherwise with nothing;
- `{variant}` with `--variant <effort>` when the launch has an effort, and otherwise with nothing; `{variant}` carries the effort slot, so `hasEffortSlot` is true for the template;
- `{model}` with the launch's `provider/model`, which the shell hands to `-m` as one word.

The command SHALL contain no token and no config path.

#### Scenario: The shell hands each slot as words
- **WHEN** the default template is composed for a launch with model `opencode/big-pickle` and effort `high` and run by `/bin/sh`
- **THEN** opencode receives the arguments `run --format json --pure --print-logs --log-level WARN -m opencode/big-pickle --variant high` with `opencode/big-pickle` as one word, and the brief on stdin

### Requirement: OpenCode config in the launch environment
Before spawning, the OpenCode runner SHALL add to the launch environment:
- `OPENCODE_CONFIG_CONTENT`: the per-launch config JSON, which outranks a repository's own `opencode.json`;

The same JSON SHALL be written to `.orchestrator/opencode.json` with mode 0600 for debugging and the work loop, and never passed to opencode as a path.

#### Scenario: Same JSON in the environment and the file
- **WHEN** an OpenCode launch is spawned
- **THEN** `.orchestrator/opencode.json` has mode 0600 and parses to the same JSON as the child's `OPENCODE_CONFIG_CONTENT`, and the child's arguments name no config path

### Requirement: OpenCode data and config isolation
Before spawning, the OpenCode runner SHALL add to the launch environment:
- `XDG_DATA_HOME=<worktree>/.orchestrator/opencode-data` when `runner.opencode.dataDir` is `launch` (a private database, log, and `auth.json`; OAuth logins of the user are then not visible);
- `XDG_CONFIG_HOME=<worktree>/.orchestrator/opencode-config`, an existing empty directory, when `runner.opencode.ignoreUserConfig` is true.

#### Scenario: Shared data and user config by default
- **WHEN** an OpenCode launch is spawned with `dataDir: shared` and `ignoreUserConfig: false` from an environment that sets neither variable
- **THEN** the child's environment sets neither `XDG_DATA_HOME` nor `XDG_CONFIG_HOME`

### Requirement: OpenCode per-launch config content
The OpenCode per-launch config JSON SHALL carry:
- `mcp.orchestrator`: `type: local`, `command: [<shim command>, ...<shim args>]`, `enabled: true`, and `timeout`, with no `environment` block. The shim inherits `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS`, and `ORCH_COMMIT_POLICY` from the agent environment;
- `snapshots: false` unless `runner.opencode.snapshots` is true;
- `share: "disabled"`;
- `permission`: the ruleset of "OpenCode permission ruleset".

#### Scenario: Shim registration and snapshots
- **WHEN** `openCodeConfig` is built with the default settings, `maxWaitMs` 3600000 and the shim `node /opt/orch/dist/agent/mcp-shim.js`, and again with `snapshots: true`
- **THEN** `mcp.orchestrator` is `{ type: "local", command: ["node", "/opt/orch/dist/agent/mcp-shim.js"], enabled: true, timeout: 3660000 }`, and the second config has no `snapshots` key

### Requirement: OpenCode MCP call timeout
MCP call timeout: opencode 1.18.30 cuts an MCP tool call at 60 000 ms by default and drops `mcp.timeout.execution` with a compatibility warning; the per-server `mcp.<id>.timeout` is honoured. `mcp.orchestrator.timeout` SHALL therefore be `runner.opencode.toolTimeoutMs` when it is set, and otherwise `maxWaitMs + 60000`.

#### Scenario: Timeout above maxWaitMs
- **WHEN** `runner.opencode.toolTimeoutMs` is unset and `maxWaitMs` is 90500
- **THEN** `mcp.orchestrator.timeout` is 150500

### Requirement: OpenCode MCP timeout key
The OpenCode per-launch config SHALL NOT emit `mcp.timeout`. The key `mcp.orchestrator.timeout` is the startup tools-fetch timeout, so a shim that hangs at startup is noticed late; a shim whose command cannot start fails at once and the run continues without the tools.

#### Scenario: No global MCP timeout
- **WHEN** an OpenCode launch is spawned
- **THEN** its `OPENCODE_CONFIG_CONTENT` has no `mcp.timeout`

#### Scenario: Shim that cannot start
- **WHEN** the launch log is test/fixtures/opencode/events/D4.jsonl, a run whose shim never started and whose turn still completed, read without its stderr
- **THEN** the run is not classified as a failure; with the stderr of D4.err it is `mcpStartupFailed`

### Requirement: OpenCode permission ruleset
Permissions: under `runner.opencode.permission: derived` (the default) the ruleset SHALL be `{ "*": "deny", read, glob, grep, list, edit, write: "allow", "bash": { "*": "deny", "git *": "allow", <one "allow" per derived rule>, <one "allow" per check-command pattern> }, "orchestrator_*": "allow" }`, with no `ask` value anywhere. In opencode 1.18.30 `write` is its own permission, not covered by `edit`, and there is no `patch` tool. Under `allow` the ruleset SHALL be `{ "*": "allow" }`.

#### Scenario: Allow mode
- **WHEN** `runner.opencode.permission` is `allow` and the derived rules are `Bash(git:*)`, `Bash(npm test:*)` and `Bash(git status)`
- **THEN** the ruleset is `{ "*": "allow" }`

#### Scenario: Derived mode allows write
- **WHEN** the ruleset is built under `derived`
- **THEN** it holds `write: "allow"` beside `edit: "allow"`, and `"orchestrator_*": "allow"`

### Requirement: OpenCode deny catch-alls
The catch-alls SHALL be `deny` because headless opencode 1.18.30 auto-rejects an `ask` and then ends the run after that step (`step_finish` reason `tool-calls`, exit 0), so the model never sees the refusal (test/fixtures/opencode/events/P-ask.jsonl). A `deny` returns "The user has specified a rule which prevents you from using this specific tool call." to the model and the run goes on (P-deny.jsonl), and the brief tells the model to turn that into a `needsAccess` question.

#### Scenario: No ask anywhere
- **WHEN** the ruleset is built under `derived`
- **THEN** its JSON contains no `ask`, and its `*` and `bash["*"]` are `deny`

#### Scenario: A deny the agent continued past
- **WHEN** the launch log is test/fixtures/opencode/events/P-deny.jsonl
- **THEN** the run is not classified as a failure

### Requirement: OpenCode catch-all first
The `deny` catch-all also overrides opencode's own `ask` defaults (`external_directory`, `doom_loop`). The catch-all SHALL come first in each map, as opencode takes the last matching rule.

#### Scenario: Catch-alls lead their maps
- **WHEN** the ruleset is built under `derived` with derived rules and a check command
- **THEN** the first key of the permission map is `*` and the first key of its `bash` map is `*`

### Requirement: Derived rules as bash patterns
A derived `Bash(x:*)` SHALL become the pattern `"x *"` and `Bash(x)` SHALL become `"x"`; other rules have no bash pattern. `"npm test *"` does not match a bare `npm test`.

#### Scenario: Rules mapped to patterns
- **WHEN** the derived rules are `Bash(git:*)`, `mcp__orchestrator__heartbeat`, `Bash(npm test:*)` and `Bash(git status)`
- **THEN** the bash patterns are `git *`, `npm test *` and `git status`, and `mcp__orchestrator__heartbeat` gives none

### Requirement: Glob-only patterns kept out of the ruleset
A pattern made only of `*`, `?` and whitespace, whether a derived rule or a check-command pattern, SHALL be skipped, so no pattern overwrites the bash `deny` catch-all whatever the rules or the check command hold.

#### Scenario: Glob-only derived rules
- **WHEN** the derived rules are `Bash(*)` and `Bash(* *)` and the check command is `npm test`
- **THEN** the bash map is `{ "*": "deny", "git *": "allow", "npm test": "allow" }`

### Requirement: OpenCode command node matching
The OpenCode runner's bash patterns SHALL rest on these facts of opencode 1.18.30: Chained commands: opencode 1.18.30 matches each command node of a bash call on its own: the text of each tree-sitter `command`, or of its `redirected_statement` when it has redirections, so a redirection stays part of its command (`npm test 2>&1` is matched whole, X-redirect-text.jsonl). `cd` is not matched against the bash rules (test/fixtures/opencode/events/X-*.jsonl, configs/X-*.json).

#### Scenario: A redirection piped onward
- **WHEN** the check command is `make 2>&1 |& cat`
- **THEN** the check-command patterns are `make 2>&1` and `cat`

### Requirement: OpenCode chain parts matched alone
The OpenCode runner's bash patterns SHALL rest on these facts of opencode 1.18.30: Each part of a `&&`, `||`, `;`, `|` or lone-`&` chain, and each command inside a `( ... )` subshell, needs a rule that allows it, and a pattern holding a whole chain, or a piece holding a parenthesis, never matches (X-ampersand.jsonl, X-ampersand-whole.jsonl, X-subshell.jsonl, X-subshell-missplit.jsonl). So `git add <f> && git commit -m <m>` runs under `git *`.

#### Scenario: Every separator splits
- **WHEN** the check command is `make lint; make test || true` followed by a newline and `cargo test | tee out.txt`
- **THEN** the check-command patterns are `make lint`, `make test`, `true`, `cargo test` and `tee out.txt`

#### Scenario: Git chains under the git pattern
- **WHEN** the ruleset is built under `derived` with no derived rules and no check command
- **THEN** the bash map is `{ "*": "deny", "git *": "allow" }`

### Requirement: Check-command splitting
The check-command patterns SHALL come from splitting the effective check command the same way opencode 1.18.30 matches a chain, outside quotes, at `&&`, `||`, `;`, `|`, `|&`, a lone `&`, newlines, `(` and `)`, with each part trimmed and duplicates dropped. A spawned launch reads the check command from its `.orchestrator/brief.json`, and the work loop passes the claim's `brief.checkCommand`.

#### Scenario: Quotes and duplicates
- **WHEN** the check command is `node -e "a && b; c | d" && node -e 'x || y' && true && true`
- **THEN** the check-command patterns are `node -e "a && b; c | d"`, `node -e 'x || y'` and `true`

#### Scenario: Check command from brief.json
- **WHEN** a launch is spawned whose `.orchestrator/brief.json` has `checkCommand: "node --test"`
- **THEN** its bash map allows `node --test`

### Requirement: Backslash escapes in the check command
A backslash SHALL escape the next character outside quotes and inside double quotes, so `echo "a \" && b"` is one command (X-escaped-quote.jsonl); single quotes have no escapes.

#### Scenario: Escaped separators
- **WHEN** the check command is `echo a\;b && echo \&`, or `echo 'a\' && true`
- **THEN** the check-command patterns are `echo a\;b` and `echo \&`; and `echo 'a\'` and `true`

### Requirement: Redirection operators stay in their command
The `&` of a redirection (`2>&1`, `>&`, `&>`, `<&`) and the `|` of `>|` SHALL stay in the command.

#### Scenario: Ampersand and pipe redirections
- **WHEN** the check command is `make &> log.txt && make <&3 && echo a >| f`
- **THEN** the check-command patterns are `make &> log.txt`, `make <&3` and `echo a >| f`

### Requirement: Substitutions stay whole in their command
A `$(...)`, backtick or `<(...)`/`>(...)` substitution SHALL stay whole in its command, quotes inside it included. An arithmetic `$((...))` SHALL stay whole with no inner patterns. Process substitution was not probed: the splitter treats `<(...)` and `>(...)` like `$(...)`, so if opencode does not match their inner commands on their own, those inner patterns are a small over-allow of commands the check command already runs.

#### Scenario: Quotes inside a substitution and arithmetic
- **WHEN** the check command is `test -z "$(git diff "a b" | head)"`, or `echo $((1 + 2)) && cat <<< "x; y"`
- **THEN** the first gives `test -z "$(git diff "a b" | head)"` whole, with `git diff "a b"` and `head`; the second gives `echo $((1 + 2))` and `cat <<< "x; y"` and no inner pattern

### Requirement: Inner commands of a substitution
The inner commands of a substitution SHALL be split the same way as the check command and get patterns of their own: opencode 1.18.30 matches the commands inside a `$(...)` or backtick substitution as well as the command that holds it, so `echo $(uname -s)` is denied under the pattern `echo $(uname -s)` alone and runs once `uname -s` is allowed too (X-subst-outer.jsonl, X-subst-inner.jsonl, X-backtick-outer.jsonl, X-backtick-inner.jsonl).

#### Scenario: Inner commands split
- **WHEN** the check command is `echo $(date; true) && true`
- **THEN** the check-command patterns are `echo $(date; true)`, `date` and `true`

### Requirement: Brace group words dropped
The `{` and `}` words of a brace group SHALL be dropped, and so SHALL a piece that starts with the `}` word, such as the `} > log` of a redirected brace group.

#### Scenario: Brace group
- **WHEN** the check command is `{ npm run lint; npm test; }`, or `{ npm test; } > log && true`
- **THEN** the check-command patterns are `npm run lint` and `npm test`; and `npm test` and `true`

### Requirement: Heredoc bodies and comments dropped
A heredoc body SHALL be dropped: after `<<WORD`, `<<-WORD`, `<<'WORD'` or `<<"WORD"` the lines following the line that carries it, up to and including the terminator line (leading tabs ignored under `<<-`), give no pattern, while the command carrying the `<<` keeps its own; a here-string `<<<` stays in its command. An unquoted `#` that starts a word SHALL drop the text through the end of the line. Heredoc bodies and comments are not command nodes, so a pattern from them could only over-allow.

#### Scenario: Tab-stripped heredoc and comments
- **WHEN** the check command is `cat <<-EOF` followed by the lines `\trm -rf x`, `\tEOF` and `true`; or the lines `# setup`, `npm ci`, `npm test #run` and `echo a#b "#c" $#`
- **THEN** the check-command patterns are `cat <<-EOF` and `true`; and `npm ci`, `npm test` and `echo a#b "#c" $#`

### Requirement: Glob-only check-command patterns
A pattern made only of `*`, `?` and whitespace SHALL never be returned. Known under-allows, where a command opencode matches may get no exact pattern of its own: a `case` pattern's `)` inside a substitution ends the substitution early.

#### Scenario: Glob-only parts skipped
- **WHEN** the check command is `* && ? ; npm test | * *`
- **THEN** the only check-command pattern is `npm test`

### Requirement: OpenCode glob characters
The OpenCode runner's bash patterns SHALL rest on these facts of opencode 1.18.30: Glob characters: opencode 1.18.30 turns `*` in a pattern into any run of characters and `?` into any one character, keeps `[` literal, and turns every backslash in both the pattern and the command into `/` before matching.

#### Scenario: Bracket kept literal
- **WHEN** the check command is `ls a?.txt [ab].txt`
- **THEN** the check-command pattern is `ls a?.txt [ab].txt`, with `?` and `[ab]` unchanged

### Requirement: No escape for OpenCode glob characters
The OpenCode runner's bash patterns SHALL rest on these facts of opencode 1.18.30: No escape for `*` or `?` exists: the pattern `cat probe-\*.txt` does not allow `cat probe-*.txt` (X-glob-escape.jsonl), while `cat probe-*.txt` allows `cat probe-other.txt` (X-glob-star.jsonl) and `cat probe-[ab].txt` allows only itself (X-glob-bracket.jsonl, X-glob-bracket-literal.jsonl).

#### Scenario: No escape added
- **WHEN** the check command is `node --test test/*.test.js`
- **THEN** the check-command pattern holds `*` with no backslash before it

### Requirement: Check-command parts allowed verbatim
Each check-command part SHALL be allowed verbatim, so a check command holding `*` or `?` yields a wildcard pattern: `node --test test/*.test.js` also allows `node --test test/<anything>.test.js`. A part ending in ` *` also allows the command without its last word, as opencode makes a trailing ` *` optional. The agent can already edit what the check command runs, so the wider pattern grants nothing the task does not have.

#### Scenario: Wildcard parts
- **WHEN** the check command is `node --test test/*.test.js && ls a?.txt [ab].txt`
- **THEN** the check-command patterns are `node --test test/*.test.js` and `ls a?.txt [ab].txt`, verbatim

### Requirement: OpenCode derived rules
The derived rules SHALL be the composed allow list when there is one. Under an opencode run, where none is composed, they SHALL be composed the same way from the detected toolchain, `runner.claude.deriveTools`, `runner.claude.allowedTools`, and the argument rules.

#### Scenario: Rules composed under an OpenCode run
- **WHEN** an `opencode` launch is prepared with `runner.claude.allowedTools` `Bash(npm test:*)` and `Bash(git status)`
- **THEN** its brief input has no `allowedTools`, and its bash patterns start with `git *` and hold `npm test *` and `git status`, each once

### Requirement: OpenCode composition exports
`composeOpenCodeCommand(launch, policy)` and `openCodeConfig(settings, allowedTools, maxWaitMs, shim, checkCommand)` SHALL be exported for the work loop.

#### Scenario: Loop command equals the runner's
- **WHEN** the work loop composes a launch's command with `composeOpenCodeCommand` and the brief swapped for its prompt file
- **THEN** the command is the one the OpenCode runner spawns, with only the brief path changed

### Requirement: Codex network access surfaces
The leaf `codex.networkAccess` SHALL be settable through `PUT /v1/config` (`{ codex: { networkAccess } }`), the `start` and `configure` tools (a flat argument `networkAccess`, folded under `codex`), `--set codex.networkAccess=<value>` (exactly `true` or `false`; any other text is a usage error naming the key) and the JSON-object form `--set codex={"networkAccess":...}`, and `orchestrator-ctl config --set` and `--clear codex.networkAccess`.

#### Scenario: The start flag and its JSON form
- **WHEN** the start arguments are `--set codex.networkAccess=false`, or `--set codex={"networkAccess":true}`, or `--set codex.networkAccess=yes`
- **THEN** the first gives `{ codex: { networkAccess: false } }`, the second `{ codex: { networkAccess: true } }`, and the third is a usage error naming `codex.networkAccess`

### Requirement: Codex network access in the configuration report
The configuration report in `status`, `GET /v1/config`, the start result and `config.json` SHALL show `config.codex.networkAccess` as `{ value, source }` with source `argument`, `file` or `default`, and the effective `runner.codex.networkAccess` SHALL be the resolved value.

#### Scenario: Sources of the leaf
- **WHEN** the file sets `runner.codex.networkAccess: true` and no override is stored, and again with neither set
- **THEN** `codex.networkAccess` is `{ value: true, source: 'file' }` and `runner.codex.networkAccess` is `true` the first time, and `{ value: undefined, source: 'default' }` the second

### Requirement: Codex network access for later launches
The value of `codex.networkAccess` SHALL apply to launches spawned or claimed after a change to it; a running launch SHALL keep its command line.

#### Scenario: Next spawned launch
- **WHEN** `codex.networkAccess` is set to `true` before the first launch of a `codex` run is spawned
- **THEN** that launch's command line carries `sandbox_workspace_write.network_access` set to `true`

### Requirement: Codex network access under every sandbox and kind
The key `codex.networkAccess` SHALL be accepted and reported under every sandbox, with a `codex.command` that has no `{codexOverrides}` slot, and under a run kind that is not `codex`, with no refusal and no warning.

#### Scenario: Read-only sandbox
- **WHEN** `codex.sandbox: read-only` and `codex.networkAccess: true` are set together
- **THEN** the change is applied, and the next launch runs with `-s read-only` and the `sandbox_workspace_write.network_access` override

#### Scenario: Run kind that is not codex
- **WHEN** a tool call passes `networkAccess: false` while the kind in force is `claude-code`
- **THEN** it is folded to `{ codex: { networkAccess: false } }` with no refusal

### Requirement: Codex settings read at command composition
Unlike the runner, model and effort fixed on the launch row at preparation, the Codex settings, `codex.sandbox` included, SHALL be read when a launch's command is composed: by the spawning runner at spawn and by the claim when a launch is claimed. A launch parked before a change to `codex.networkAccess` and claimed after it SHALL run with the new value and the brief of its last preparation.

#### Scenario: Sandbox read at spawn
- **WHEN** `codex.sandbox` is set to `read-only` at runtime before a `codex` launch is spawned
- **THEN** the spawned command runs with `-s read-only`
