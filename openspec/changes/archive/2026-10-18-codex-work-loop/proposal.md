## Why

A Codex operator session has nothing that runs `hosts/claude-code/workflows/work.js`: Codex has no Workflow tool. Pull mode therefore had no Codex equivalent, and every Codex launch was spawned by the daemon. Milestone 2 needs Codex workers that claim launches the way Claude Code session workers do.

## What Changes

- New `hosts/codex/bin/work.mjs`, also the package executable `orchestrator-work`. It is started from a shell, which is the documented primary path, because a background process outliving a Codex turn is unverified. N loops in one process claim over HTTP with `workerId <runTag>-<n>` and `runner: "codex"`. For each claim a loop writes the shim env file and runs `codex exec` in the claimed worktree. The command is composed by `composeCodexCommand`, the function the Codex runner uses: the same `-c mcp_servers.orchestrator.*` overrides, approval keys and `--orch-env-file` token transport, `-m` and the effort from the claim, and on stdin a short preamble followed by the brief. After codex exits, the loop posts the summed `turn.completed.usage` to `POST /v1/launches/:id/usage`. When codex failed to start (no turn began), it releases the launch with `keep: true`. When codex ran but did not report, it releases without keep. It then claims again until the stop rule holds.
- `src/runner/codex.ts` exports `composeCodexCommand(launch, policy)` and `writeCodexShimEnv`, and `CodexRunner` composes through them (a new `compose` hook on `SubprocessRunner`). `fixedSlots` is factored out of `SubprocessRunner.spawn`.
- The claim response gains `commitPolicy` for every launch. A codex launch's response also gains `codex: { settings, maxWaitMs, retryWindowMs, env }`, holding the effective `runner.codex` keys, the long-poll ceiling and the agent environment, so the loop composes exactly what a spawned launch would get.
- agent-protocol "Worker access": the per-launch MCP façade is still not spawned by the daemon for a claimed launch, but a worker loop that spawns an agent process may register it for that process (option a). The fallback-file rule is unchanged.
- `hosts/codex/skills/run/SKILL.md` and the Codex host README document the loop. `work.js` is untouched: it claims only `claude-code` launches.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `host-integration`: ADDED `Codex work loop`.
- `pull-runner`: MODIFIED `Claim` (the response carries `runner`, `commitPolicy`, and for a codex launch `codex`).
- `agent-protocol`: MODIFIED `Worker access` (the façade delta).

## Impact

- Code: `hosts/codex/bin/work.mjs`, `src/runner/codex.ts`, `src/runner/subprocess.ts`, `src/loop/orchestrator.ts` (`claimResponse`), `src/index.ts`, `package.json` (bin).
- Tests: `test/slice/codex-work.test.ts`; opt-in `test/e2e/codex-work.test.ts` (`ORCH_E2E_CODEX_WORK=1`).
- Unverified alternative: Codex's `features.multi_agent` subagents could work claimed launches inside the session, as Claude Code's Workflow subagents do. This has not been probed.
- Drawback: a second worker implementation to maintain beside `work.js`.
