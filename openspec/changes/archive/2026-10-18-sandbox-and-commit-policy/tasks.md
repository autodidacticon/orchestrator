## 1. Policy keys

- [x] 1.1 `src/runner/selection.ts`: `COMMIT_POLICIES`, `CODEX_SANDBOXES`, `defaultCodexCommit`; `src/config.ts`: `runner.claude.commit` (default `agent`), `runner.codex.sandbox` (default `workspace-write`), `runner.codex.commit` (optional)
- [x] 1.2 `src/runs/resolve.ts`: `claude.commit` override leaf and `ClaudeLeaves`; `codex.commit` derived from the resolved sandbox; `config.runner.{claude,codex}.commit` always set; the report carries `config.claude`
- [x] 1.3 `test/runs/resolve.test.ts`: the derived default, the sandbox override, an explicit commit, `--set claude.commit`

## 2. Launch and sealing

- [x] 2.1 `src/state/store.ts`: `Launch.commitPolicy`, `commitPolicyOf`; `src/launch/launch.ts` and `src/loop/core.ts`: `commitPolicyFor(kind)` at preparation, on the row and in `launch.created`
- [x] 2.2 `src/workspace/*`: `seal(launch, { autoCommit })`; the shared commit helper with `preserve()`; `FakeWorkspace` commits a dirty launch and records `autoCommits`
- [x] 2.3 `src/loop/orchestrator.ts`: `sealSubmission`, `sealFallback`; `handleReport`, `tick.ts`, and `recovery.ts` use them; `committedByOrchestrator` in `agent.report` and `agent.fallback`
- [x] 2.4 `test/agents/scripted.ts` `submitDirty`; `test/slice/launch.test.ts` daemon commit and the empty submission; `test/slice/verifier.test.ts` the trailer; `test/loop/scenarios.test.ts` codex derived daemon at submit and at a fallback submit

## 3. Agent-facing text

- [x] 3.1 `src/agent/mcp-shim.ts`: `reportDescription` keyed by `ORCH_COMMIT_POLICY`; `agentEnv` and `ClaudeCodeRunner`'s `mcp.json` carry it for a daemon launch; `test/slice/shim.test.ts`
- [x] 3.2 `briefInput` passes `runner.commitPolicy` and `runner.sandbox`
- [x] 3.3 `src/health/stuck.ts`: a runner-neutral nudge; `test/loop/health.test.ts`

## 4. Finish

- [x] 4.1 Spec deltas for worker-runners and agent-protocol; README keys, defaults, and the workspace-write limitation; `openspec/specs/` is updated when the change is archived
