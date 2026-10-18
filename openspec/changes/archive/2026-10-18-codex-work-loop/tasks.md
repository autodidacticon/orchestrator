## 1. Runner

- [x] 1.1 `src/runner/codex.ts`: `composeCodexCommand(launch, policy)` and `writeCodexShimEnv`; `CodexRunner` composes through them; exported from `src/index.ts`
- [x] 1.2 `src/runner/subprocess.ts`: `fixedSlots` and the `compose` hook

## 2. Daemon

- [x] 2.1 `claimResponse` carries `commitPolicy`, and `codex: { settings, maxWaitMs, retryWindowMs, env }` for a codex launch

## 3. Host

- [x] 3.1 `hosts/codex/bin/work.mjs`: workers/runTag/capacity (clamped with a log line), claim with `runner: "codex"`, compose and run `codex exec`, post usage, release with keep on a failed start, stop rule
- [x] 3.2 `package.json` bin `orchestrator-work`
- [x] 3.3 `hosts/codex/skills/run/SKILL.md` and `hosts/codex/README.md` document the loop

## 4. Tests

- [x] 4.1 `test/slice/codex-work.test.ts`: two loops with the fake codex on PATH drain a three-task pull-mode codex graph; a codex that fails to start is released with keep; `composeCodexCommand` is the runner's command
- [x] 4.2 `test/e2e/codex-work.test.ts` (opt-in `ORCH_E2E_CODEX_WORK=1`): two real codex loops drain a three-task graph with one trailer commit per task

## 5. Specs

- [x] 5.1 Deltas for host-integration (ADDED `Codex work loop`), pull-runner (MODIFIED `Claim`), and agent-protocol (MODIFIED `Worker access`); `openspec/specs/` is updated when the change is archived
