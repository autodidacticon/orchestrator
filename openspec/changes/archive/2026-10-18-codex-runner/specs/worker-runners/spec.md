## ADDED Requirements

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
