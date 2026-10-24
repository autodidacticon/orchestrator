# Worker Runners Specification

## Purpose
The agent CLIs a launch can run under: the runner kinds, how a run selects one, each kind's configuration block and defaults, and the effort levels each kind accepts. The Codex runner itself (its command, sandbox, and commit policy) and how a launch is prepared under a kind are specified where they are built; this capability owns the kinds and their configuration.
## Requirements
### Requirement: Runner kinds and defaults
The configuration SHALL carry `runner.kind`, one of `claude-code`, `codex`, and `opencode`, defaulting to `claude-code`, and one block per kind: `runner.claude`, `runner.codex`, and `runner.opencode`. `runner.kind` SHALL resolve through the configuration layers as the key `runnerKind`: an argument (a `start` argument, a `--set` flag, or a runtime override) beats the file, which beats the default; it SHALL NOT be detected, pinned, or start-only, and a change SHALL apply to launches prepared afterwards. A value outside the kinds SHALL be refused at configuration time naming `runner.kind` in the file and `runnerKind` as an argument. Each kind SHALL have its own default model: `claude-opus-5-5` for `claude-code`, `gpt-6-astra` for `codex`, and `anthropic/claude-opus-5-5` for `opencode` (the Claude Code default reached through the user's OpenCode Anthropic login); all default to effort `medium`. `runner.codex` SHALL carry `command` (unset by default, so the runner's built-in template applies), `model`, `effort`, `sandbox` (`read-only`, `workspace-write`, or `danger-full-access`, default `workspace-write`), `commit` (`agent` or `daemon`, unset by default), `networkAccess` (unset by default), `ignoreUserConfig` (default true), `ephemeral` (default true), `mcpApproval`, `toolTimeoutSec`, and `startupTimeoutSec`; the semantics of the policy keys belong to the Codex runner. `runner.opencode` SHALL carry `command` (unset by default), `model` (a `provider/model` id), `effort`, `commit` (`agent` or `daemon`, default `agent`), `permission` (`derived` or `allow`, default `derived`), `dataDir` (`shared` or `launch`, default `shared`), `ignoreUserConfig` (default false), `pure` (default true), and `snapshots` (default false); the semantics of the policy keys belong to the OpenCode runner. The run default `model` and `effort` SHALL be those of the kind in force, so a run under `codex` never resolves a Claude model. Every operator surface SHALL expose the kind and the per-kind keys. These are `orchestrator-ctl start --set runnerKind=... --set codex.<leaf>=...`, `orchestrator-ctl config --runner-kind --sandbox --commit`, the MCP `start` and `configure` tools (`runnerKind`, `codex`, `sandbox`, `commit`), and `PUT /v1/config`. Each surface that names a default SHALL name both kinds' defaults.

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
Each runner kind SHALL accept its own set of effort levels: `claude-code` accepts `low`, `medium`, `high`, `xhigh`, and `max`; `codex` accepts those and `ultra`; `opencode` accepts the `claude-code` set and passes the level through as `--variant`, which variants a model lists being the CLI's to decide. The set SHALL be a superset check: a model of the kind may accept fewer levels, and the CLI remains the final validator. `runner.claude.effort`, `runner.codex.effort`, and `runner.opencode.effort` in the file, and an `effort` argument, SHALL be validated against the set of their kind, and a refusal SHALL name `effort` and the kind. A task's `effort` selector, in the graph file or from an import label, SHALL be validated against the union of every kind's set, since the kind a task runs under is decided when its launch is prepared. Each kind SHALL define the level it runs at in place of one it lacks (`ultra` as `max` for `claude-code` and for `opencode`); the moment that mapping applies belongs to launch preparation.

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
The daemon SHALL hold one agent runner per runner kind behind a single dispatching runner, and SHALL route `spawn`, `alive`, `liveness`, `reap`, and `readUsage` for a launch to the runner of the kind fixed on its row, so a launch observed after a restart reaches the runner and the usage parser it was prepared for. A row without a kind SHALL be treated as `claude-code`. Killing by launch id, where only the id is known, SHALL be asked of every registered runner. A launch whose kind has no registered runner SHALL fail at spawn with an error naming the kind; its liveness SHALL be `unknown` and it SHALL have no usage. The allow list SHALL be given only to the brief of a `claude-code` launch. Because the kind on the row comes from the task's `runner` selector when it has one (see model-selection "Task selectors"), one run MAY hold launches of both kinds at once.

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
The configuration SHALL carry `runner.codex.sandbox` with one of `read-only`, `workspace-write`, or `danger-full-access`, defaulting to `workspace-write`. Each runner kind SHALL carry a commit policy, `runner.<kind>.commit`, with one of `agent` (the agent commits before it submits) or `daemon` (the daemon commits what the agent left when it submits). `runner.claude.commit` SHALL default to `agent`. OpenCode has no sandbox, only per-tool permission rules, so nothing stands between its agent and git: `runner.opencode.commit` SHALL default to `agent` and SHALL NOT be derived. When `runner.codex.commit` is unset it SHALL be derived from the sandbox in force: `daemon`, or `agent` when the sandbox is `danger-full-access`. The reason is that under `workspace-write` Codex cannot run `git add` or `git commit` in a linked worktree: the index lock under `<repo>/.git/worktrees/<wt>/` is refused with `Operation not permitted`, and Codex keeps `.git` and the resolved gitdir read-only even inside writable roots. `codex.sandbox`, `codex.commit`, `claude.commit`, and `opencode.commit` SHALL be accepted as runtime overrides that apply to launches prepared afterwards. A derived value moves with a sandbox override, and an explicit `commit` wins over the derivation. The policy SHALL be resolved from the launch's runner kind when the launch is prepared, recorded on the launch row as `commitPolicy` and in `launch.created`, and passed to the brief input with the sandbox of a `codex` launch and the permission mode (and derived bash patterns) of an `opencode` launch. An `opencode` launch has no sandbox in its brief input. A row without a policy SHALL be treated as `agent`. Under `daemon` the daemon SHALL set `ORCH_COMMIT_POLICY=daemon` in the agent's environment and in the MCP façade's.

The brief SHALL follow the policy. Under `agent` it SHALL tell the agent to commit all work and resubmit after a 409. It SHALL allow rebasing the launch branch onto the integration head, and tell the agent to rebase a conflicted branch, merge or cherry-pick an interrupted one and squash its work-in-progress commit, and commit a revision delta. Under `daemon` it SHALL tell the agent to leave its changes in the worktree, committed or not, because the orchestrator commits what is uncommitted when it accepts the report. It SHALL say the orchestrator rebases the branch at verification, and tell the agent to inspect a prior branch with `git show`/`git diff` and reapply the changes as file edits. Under `daemon` none of the agent-side git-write instructions SHALL appear. A `codex` launch's brief SHALL also name its sandbox mode and tell the agent that a refused command is not approved at runtime and is to be asked for with a `needsAccess` question rather than retried.

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

### Requirement: Codex runner command composition
The Codex runner SHALL spawn `DEFAULT_CODEX_COMMAND`, or `runner.codex.command` when it is set:

`codex exec --json {ephemeral} {ignoreUserConfig} -C {worktree} -m {model} -c model_reasoning_effort='"{effort}"' -s {sandbox} {codexOverrides} -o {worktree}/.orchestrator/last-message.txt - < {brief}`

The template SHALL use only flags verified against the Codex CLI. It SHALL NOT contain `--full-auto` or `--dangerously-bypass-approvals-and-sandbox`, and it SHALL have no `{allowedTools}` slot.

At every spawn the runner SHALL fill the slots from the effective `runner.codex`:
- `{sandbox}` with `sandbox`;
- `{ephemeral}` with `--ephemeral` when `ephemeral` is true (the default), and otherwise with nothing;
- `{ignoreUserConfig}` with `--ignore-user-config` when `ignoreUserConfig` is true (the default), and otherwise with nothing;
- `{codexOverrides}` with `-c` overrides that register the orchestrator shim as the MCP server `orchestrator`.

The overrides SHALL set:
- `command` and `args`: the shim entrypoint followed by `--orch-env-file <worktree>/.orchestrator/shim.env`;
- `required=true`;
- `startup_timeout_sec`: `startupTimeoutSec`, default 30;
- `tool_timeout_sec`: `toolTimeoutSec`, default `ceil(maxWaitMs/1000)+60`;
- the approval string, then `sandbox_workspace_write.network_access=true` when `networkAccess` is true.

The approval string SHALL be `runner.codex.mcpApproval` when it is set. Otherwise it SHALL be `approval_policy="never"`, `mcp_servers.orchestrator.default_tools_approval_mode="approve"`, and `mcp_servers.orchestrator.tools.<tool>.approval_mode="approve"` for each of `heartbeat`, `report`, `block`, `inbox`, and `log`.

Before spawning, the runner SHALL write `.orchestrator/shim.env` with mode 0600, holding `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, and `ORCH_RETRY_WINDOW_MS` (and `ORCH_COMMIT_POLICY` when the launch has the `daemon` policy). The runner SHALL NOT set `CODEX_HOME` per launch.

#### Scenario: Default composition
- **WHEN** a codex launch with model `gpt-6-astra` and effort `xhigh` is spawned under the default `runner.codex` and `maxWaitMs`
- **THEN** the command contains `codex exec --json`, `--ephemeral`, `--ignore-user-config`, `-C <worktree>`, `-m gpt-6-astra`, `model_reasoning_effort='"xhigh"'`, `-s workspace-write`, the approval keys for all five tools, `required=true`, `startup_timeout_sec=30`, and `tool_timeout_sec=3660`, and ends with ` - < <brief>`
- **AND** the command contains no token

#### Scenario: Keys change the command
- **WHEN** `runner.codex` sets `toolTimeoutSec: 120`, `ephemeral: false`, `networkAccess: true`, and `sandbox: danger-full-access`
- **THEN** the command has `tool_timeout_sec=120`, no `--ephemeral`, `sandbox_workspace_write.network_access=true`, and `-s danger-full-access`

#### Scenario: Operator approval string
- **WHEN** `runner.codex.mcpApproval` is set
- **THEN** it replaces the default approval overrides verbatim

### Requirement: Codex usage parsing
`CodexRunner.readUsage` SHALL read the launch log. The parser SHALL:
- read at most the last 256 KiB, line by line;
- `JSON.parse` each line and skip lines that fail;
- sum `usage` over every `turn.completed` line into `tokens`: `input_tokens` to `input` (which already counts cached input), `cached_input_tokens` to `cachedInput`, `cache_write_input_tokens` to `cacheWriteInput`, `output_tokens` to `output`, and `reasoning_output_tokens` to `reasoningOutput`.

The usage SHALL have `source: 'codex'`. `costUsd`, `durationMs`, and `turns` SHALL be left unset: one exec is one Codex turn, which is not comparable with Claude's `num_turns`. A log without a `turn.completed` that has input and output counts SHALL yield no usage.

#### Scenario: Probe log with stderr interleaved
- **WHEN** the log holds the probe's JSONL with stderr lines between them
- **THEN** the usage is `tokens { input: 40361, cachedInput: 32128, cacheWriteInput: 0, output: 260, reasoningOutput: 0 }` with `source: 'codex'`

#### Scenario: Two turns sum
- **WHEN** the log holds two `turn.completed` lines
- **THEN** each token field is their sum

#### Scenario: No turn.completed
- **WHEN** the log was cut off before `turn.completed`, or is a Claude log
- **THEN** no usage is read

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

Permissions: under `runner.opencode.permission: derived` (the default) the ruleset SHALL be `{ "*": "deny", read, glob, grep, list, edit, write: "allow", "bash": { "*": "deny", "git *": "allow", <one "allow" per derived rule>, <one "allow" per check-command pattern> }, "orchestrator_*": "allow" }`, with no `ask` value anywhere. The catch-alls SHALL be `deny` because headless opencode 1.18.30 auto-rejects an `ask` and then ends the run after that step (`step_finish` reason `tool-calls`, exit 0), so the model never sees the refusal (test/fixtures/opencode/events/P-ask.jsonl). A `deny` returns "The user has specified a rule which prevents you from using this specific tool call." to the model and the run goes on (P-deny.jsonl), and the brief tells the model to turn that into a `needsAccess` question. The `deny` catch-all also overrides opencode's own `ask` defaults (`external_directory`, `doom_loop`). In 1.18.30 `write` is its own permission, not covered by `edit`, and there is no `patch` tool. A derived `Bash(x:*)` SHALL become the pattern `"x *"` and `Bash(x)` SHALL become `"x"`; other rules have no bash pattern. The catch-all SHALL come first in each map, as opencode takes the last matching rule. `"npm test *"` does not match a bare `npm test`. Under `allow` the ruleset SHALL be `{ "*": "allow" }`.

Chained commands: opencode 1.18.30 matches each command node of a bash call on its own: the text of each tree-sitter `command`, or of its `redirected_statement` when it has redirections, so a redirection stays part of its command (`npm test 2>&1` is matched whole, X-redirect-text.jsonl). Each part of a `&&`, `||`, `;`, `|` or lone-`&` chain, and each command inside a `( ... )` subshell, needs a rule that allows it, and a pattern holding a whole chain, or a piece holding a parenthesis, never matches (X-ampersand.jsonl, X-ampersand-whole.jsonl, X-subshell.jsonl, X-subshell-missplit.jsonl). `cd` is not matched against the bash rules (test/fixtures/opencode/events/X-*.jsonl, configs/X-*.json). So `git add <f> && git commit -m <m>` runs under `git *`. The check-command patterns SHALL come from splitting the effective check command the same way, outside quotes, at `&&`, `||`, `;`, `|`, `|&`, a lone `&`, newlines, `(` and `)`, with each part trimmed and duplicates dropped. A backslash SHALL escape the next character outside quotes and inside double quotes, so `echo "a \" && b"` is one command (X-escaped-quote.jsonl); single quotes have no escapes. The `&` of a redirection (`2>&1`, `>&`, `&>`, `<&`) and the `|` of `>|` SHALL stay in the command, a `$(...)` substitution SHALL stay whole in its command (its inner commands get no pattern of their own), and the `{` and `}` words of a brace group SHALL be dropped. A spawned launch reads the check command from its `.orchestrator/brief.json`, and the work loop passes the claim's `brief.checkCommand`.

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

### Requirement: OpenCode usage parsing
`OpenCodeRunner.readUsage` SHALL read the launch log. The parser SHALL:
- read the whole log, line by line, streaming the file so memory stays bounded by the read chunk and the line cap, not the log size. OpenCode reports usage per step, not as a running total, so a step dropped from the read is usage lost; the log also carries full tool outputs and WARN-level stderr, so a tail window would drop the early steps of any task that reads large files;
- skip a line longer than 64 KiB without parsing its body: `step_finish` lines are a few hundred bytes, and the long lines are tool output;
- `JSON.parse` each line and skip lines that fail;
- for every line with `type: "step_finish"`, add `part.tokens.input + part.tokens.cache.read` to `input` (opencode's `input` excludes cache reads), `cache.read` to `cachedInput`, `cache.write` to `cacheWriteInput`, `output` to `output`, `reasoning` to `reasoningOutput`, and `part.cost` to `costUsd`.

The usage SHALL have `source: 'opencode'`, `turns` the number of `step_finish` lines with `reason: "stop"`, and no `durationMs`. A log without a `step_finish` that has input and output counts SHALL yield no usage.

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

#### Scenario: No step_finish
- **WHEN** the log was cut before any `step_finish`, or is a Codex log
- **THEN** no usage is read

### Requirement: OpenCode e2e fixture recording
The opt-in OpenCode e2e (test/e2e/opencode.test.ts) SHALL write fixtures only under `ORCH_E2E_OPENCODE_RECORD=1`, copying each task's first launch's JSONL events to test/fixtures/opencode/e2e-<task>.jsonl (e2e-<case>-<task>.jsonl for other cases). Before writing, the recorder SHALL redact the text: every scratch path (the run directory, with and without a leading `/private`) SHALL become `<scratch>`, the home directory SHALL become `~`, the name of every git `Author:` line SHALL become `Fixture Author`, and every email address SHALL become `author@example.invalid`. A committed OpenCode fixture SHALL carry no email address other than an `example.invalid` one.

#### Scenario: A git author line is redacted
- **WHEN** a recorded event holds the output of `git show --stat HEAD` with `Author: Jane Q. Doe <jane.doe+git@mail.example.com>` and a `Co-Authored-By: Bot <noreply@anthropic.com>` trailer
- **THEN** the fixture holds `Author: Fixture Author <author@example.invalid>` and `Co-Authored-By: Bot <author@example.invalid>`, and neither the name nor either address

#### Scenario: Scratch paths and the home directory are redacted
- **WHEN** a recorded event names a path under the run directory or the home directory
- **THEN** the fixture names it under `<scratch>` or `~`

#### Scenario: Committed fixtures carry no personal address
- **WHEN** `git grep -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- test/fixtures/opencode` runs
- **THEN** every match is an `example.invalid` address

### Requirement: OpenCode e2e contended-death counter rule
The opt-in OpenCode end-to-end test SHALL check the counter rule of task-lifecycle "Retry and exhaustion" from `health.contendedRetries`, not from the events' own flags. A task's deaths with reason `startupContended` up to that allowance SHALL record `charged: false` and later ones `charged: true`. The task's attempts SHALL equal its launches minus one minus the uncharged deaths so counted.

#### Scenario: Charged death within the allowance
- **WHEN** the check, run by a unit test without opencode, is given a task whose first `startupContended` death records `charged: true` with the allowance at 2, and attempts consistent with that flag
- **THEN** the check fails

#### Scenario: Deaths as the rule says
- **WHEN** a task's first two `startupContended` deaths record `charged: false` and a third `charged: true`, with the allowance at 2, four launches and one attempt
- **THEN** the check passes

