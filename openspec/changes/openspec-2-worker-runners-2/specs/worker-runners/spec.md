## MODIFIED Requirements

### Requirement: Codex runner command composition
The Codex runner SHALL spawn `DEFAULT_CODEX_COMMAND`, or `runner.codex.command` when it is set:

`codex exec --json {ephemeral} {ignoreUserConfig} -C {worktree} -m {model} -c model_reasoning_effort='"{effort}"' -s {sandbox} {codexOverrides} -o {worktree}/.orchestrator/last-message.txt - < {brief}`

The template SHALL use only flags verified against the Codex CLI. It SHALL NOT contain `--full-auto` or `--dangerously-bypass-approvals-and-sandbox`, and it SHALL have no `{allowedTools}` slot.

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


## ADDED Requirements

### Requirement: Codex runner command composition: template slots
At every spawn the Codex runner SHALL fill the slots of the Codex command template from the effective `runner.codex`:
- `{sandbox}` with `sandbox`;
- `{ephemeral}` with `--ephemeral` when `ephemeral` is true (the default), and otherwise with nothing;
- `{ignoreUserConfig}` with `--ignore-user-config` when `ignoreUserConfig` is true (the default), and otherwise with nothing;
- `{codexOverrides}` with `-c` overrides that register the orchestrator shim as the MCP server `orchestrator`.

#### Scenario: Flags left out when their keys are false
- **WHEN** a codex launch is spawned with `runner.codex` setting `ephemeral: false` and `ignoreUserConfig: false`
- **THEN** the command contains neither `--ephemeral` nor `--ignore-user-config`
- **AND** it still contains `-c mcp_servers.orchestrator.command=` and `-c mcp_servers.orchestrator.args=`, and no `{...}` slot is left unfilled

### Requirement: Codex runner command composition: MCP server overrides
The `{codexOverrides}` overrides SHALL set:
- `command` and `args`: the shim entrypoint followed by `--orch-env-file <worktree>/.orchestrator/shim.env`;
- `required=true`;
- `startup_timeout_sec`: `startupTimeoutSec`, default 30;
- `tool_timeout_sec`: `toolTimeoutSec`, default `ceil(maxWaitMs/1000)+60`;
- the approval string, then `sandbox_workspace_write.network_access=true` when `networkAccess` is true.

#### Scenario: Timeouts follow the keys and maxWaitMs
- **WHEN** `runner.codex` sets `startupTimeoutSec: 5`, or sets no `toolTimeoutSec` while `maxWaitMs` is 90500
- **THEN** the overrides hold `startup_timeout_sec=5` in the first case and `tool_timeout_sec=151` in the second

#### Scenario: Shim registered with its env file
- **WHEN** a codex launch in worktree `/wt/L1` is composed under the default `runner.codex`
- **THEN** the overrides set `mcp_servers.orchestrator.args` to the shim entrypoint followed by `--orch-env-file` and `/wt/L1/.orchestrator/shim.env`, and hold no `network_access`

### Requirement: Codex runner command composition: approval string
The approval string SHALL be `runner.codex.mcpApproval` when it is set. Otherwise it SHALL be `approval_policy="never"`, `mcp_servers.orchestrator.default_tools_approval_mode="approve"`, and `mcp_servers.orchestrator.tools.<tool>.approval_mode="approve"` for each of `heartbeat`, `report`, `block`, `inbox`, and `log`.

#### Scenario: Default approvals reach codex as one word each
- **WHEN** the default command of a codex launch is run by `/bin/sh` with `runner.codex.mcpApproval` unset
- **THEN** codex receives `approval_policy="never"` and `mcp_servers.orchestrator.tools.block.approval_mode="approve"` each as one argument after a `-c`

### Requirement: Codex runner command composition: launch environment
Before spawning, the Codex runner SHALL write `.orchestrator/shim.env` with mode 0600, holding `ORCH_API`, `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, and `ORCH_RETRY_WINDOW_MS` (and `ORCH_COMMIT_POLICY` when the launch has the `daemon` policy). The Codex runner SHALL NOT set `CODEX_HOME` per launch.

#### Scenario: Shim env file written before the command runs
- **WHEN** a codex launch `L1` is spawned with `ORCH_API=http://127.0.0.1:9` and `ORCH_COMMIT_POLICY=daemon` in its environment and a retry window of 5000 ms
- **THEN** `<worktree>/.orchestrator/shim.env` has mode 0600 and holds `ORCH_API=http://127.0.0.1:9`, `ORCH_LAUNCH_ID=L1`, the launch token as `ORCH_TOKEN`, `ORCH_RETRY_WINDOW_MS=5000`, and `ORCH_COMMIT_POLICY=daemon`
- **AND** the composed command then runs in the worktree

#### Scenario: No per-launch CODEX_HOME
- **WHEN** a codex launch is spawned by a daemon whose own environment has no `CODEX_HOME`
- **THEN** neither the Codex runner nor the daemon's agent environment adds a `CODEX_HOME`, so the agent's environment has none either
