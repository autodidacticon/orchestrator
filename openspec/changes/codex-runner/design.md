## Context

The facts come from probes of codex-cli 0.163.0 on 2026-10-18, recorded in Linear ORC-47 and the P-ORC-6 project description:

- `codex exec --json` prints JSONL on stdout and keeps progress on stderr.
- `turn.completed{usage}` is the last line.
- `required=true` makes a server that fails to start exit 1.
- Under `approval_policy="never"`, an MCP call needs both `default_tools_approval_mode` and the per-tool `approval_mode` set to `approve`.
- The MCP server child is not sandboxed. It receives only a fixed set of variables plus `mcp_servers.<id>.env`.

## Decisions

**Slots through `extraVars`.** `SubprocessRunnerOptions.extraVars(launch)` returns runner-specific slots, which are merged after the fixed set. `CodexRunner` passes a closure over its options, so the slots come from the effective `runner.codex` at each spawn. A runtime `codex.sandbox` override therefore reaches the next launch.

**Token transport.** The runner writes `.orchestrator/shim.env` as `KEY=VALUE` lines with mode 0600, using chmod after the write because `mode` only applies when a file is created. The shim's argv names only the path. The shim layers the file over its process environment and exits 1 with `--orch-env-file <path>: cannot read the shim env file (<code>)` when the file is missing. `mcp_servers.<id>.env_vars` forwarding was not used because its behaviour is unprobed.

**Flag name `--orch-env-file`, not `--env-file`.** Node 22 reads `--env-file` from anywhere in argv, including after the script name. `node mcp-shim.js --env-file x` makes node itself load the file, or exit 9 with `node: x: not found` before the shim runs. The shim's own flag has to be a name Node does not claim.

**`shimEnv` carries ORCH_COMMIT_POLICY.** Codex launches default to the `daemon` commit policy. The shim phrases the `report` tool from `ORCH_COMMIT_POLICY`, so the helper forwards the variable when the agent environment has it. `extra` stays available for later variables.

**Quoting.** Each `-c` value is a TOML literal (strings via `JSON.stringify`, a valid TOML basic string for these values), wrapped in shell single quotes. A test runs the composed command through `/bin/sh` with a `codex` function that prints its argv, and checks that each value arrives as one word. `substitute()` is a single pass over the template with `\{(\w+)\}`, so it never touches a value's braces or a TOML inline table.

**Usage.** `parseCodexUsage` reads the last 256 KiB line by line, parses each line that looks like a `turn.completed`, skips failures, and sums the five token fields. Codex's `input_tokens` already includes cached input, so `input` is taken as it is. `turns`, `costUsd`, and `durationMs` stay unset. One exec is one Codex turn, which is not comparable with Claude's `num_turns`.

## Fixtures

test/fixtures/codex/ holds **reconstructed** fixtures, not byte copies. The probe scratchpad existed, but the worker's sandbox could not read outside its worktree, so each file was rebuilt from the recorded facts. `git-events.jsonl` keeps the recorded `thread_id` and `turn.completed` usage exactly. The other files' usage numbers are synthetic, and event shapes other than the documented ones are approximate. test/fixtures/codex/README.md maps each file to its original. Replace them with the originals if byte-identical copies matter (ORC-50).

## Risks

- The approval string is a frozen probe result. `runner.codex.mcpApproval` lets an operator replace it when Codex changes.
- The `-c` line is long and visible in `ps`. It names the env file's path, never the token.
- The agent's own environment still carries `ORCH_TOKEN` (as for Claude); only argv is kept clean.
