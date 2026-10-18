## Why

Since ORC-44, a launch carries `runner: codex`, but no runner is registered for that kind, so a Codex launch fails at spawn. Spawning `codex exec` as-is would hit four problems found by probing codex-cli 0.163.0 on 2026-10-18:

- Registering the shim through `-c mcp_servers.orchestrator.env={ORCH_TOKEN=...}` puts the launch token on argv, where `ps` shows it.
- The MCP server Codex starts receives none of the agent's `ORCH_*` variables.
- The default 60 s tool timeout fails every `block` call long before `maxWaitMs`.
- A non-required server that fails to start goes unnoticed, and under `approval_policy="never"` every MCP tool call is refused unless approvals are pre-granted.

## What Changes

- `DEFAULT_CODEX_COMMAND` (src/runner/command.ts) uses only verified flags: `codex exec --json {ephemeral} {ignoreUserConfig} -C {worktree} -m {model} -c model_reasoning_effort='"{effort}"' -s {sandbox} {codexOverrides} -o {worktree}/.orchestrator/last-message.txt - < {brief}`.
- `CodexRunner` (src/runner/codex.ts) extends `SubprocessRunner` and fills `{sandbox}`, `{ephemeral}`, `{ignoreUserConfig}`, and `{codexOverrides}` at every spawn through the new `SubprocessRunnerOptions.extraVars`. `{codexOverrides}` registers the shim:
  - required, with a startup timeout of 30 s by default;
  - with a tool timeout of `ceil(maxWaitMs/1000)+60` s by default;
  - with approvals pre-granted (`runner.codex.mcpApproval` replaces them);
  - with `network_access` when `runner.codex.networkAccess` is set.
- The token reaches the shim through `.orchestrator/shim.env` (mode 0600), named by the shim's new `--orch-env-file <path>` flag. Argv carries no token. `mcp.json` is also 0600.
- `shimCommand()` and a new `shimEnv()` live in src/runner/shim-command.ts, and both runners use them. `agentEnv` adds `ORCH_RETRY_WINDOW_MS`.
- `parseCodexUsage` sums `turn.completed` usage into runner-neutral tokens. `CodexRunner.readUsage` reads the launch log.
- `main.ts` registers `CodexRunner` in the `MultiRunner` codex slot.

## Capabilities

### Modified Capabilities
- `worker-runners`: ADDED `Codex runner command composition` and `Codex usage parsing`.
- `toolchain-discovery`: `Runner command composition` now has one template per kind, each with its own slots.
- `agent-protocol`: changes `Launch token scoping`, `Block and wait`, `MCP façade`, and `Agent environment`.
- `health-monitoring`: `Usage accounting` names the Codex reader.

## Impact

- Code: src/runner/{codex,shim-command,command,subprocess,claude-code}.ts, src/agent/mcp-shim.ts, src/loop/orchestrator.ts (`agentEnv`), src/main.ts, src/index.ts.
- Behaviour for claude-code launches is unchanged, except that `mcp.json` is now 0600.
