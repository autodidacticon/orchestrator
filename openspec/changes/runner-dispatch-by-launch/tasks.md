## 1. Kind fixed at preparation

- [x] 1.1 `src/runner/selection.ts`: `Selection { runner, model, effort, effortRequested? }`; `src/loop/orchestrator.ts` `selectionFor` resolves the kind, the kind's own defaults, the per-kind effort check, and the fallback; `src/loop/core.ts` returns `Selection`
- [x] 1.2 `src/state/store.ts`: `Launch.runner?: RunnerKind` and `runnerOf`; `src/launch/launch.ts` stores `runner` on the row and in `launch.created` with `effortRequested`; `status.liveLaunches[]` and the claim response carry `runner`
- [x] 1.3 `test/loop/selection.test.ts`: default and codex kinds on the row, event, and status; a `runnerKind` override reaches only later launches; codex defaults; `ultra` under each kind

## 2. Dispatch

- [x] 2.1 `src/runner/multi.ts`: `MultiRunner` routes by `runnerOf(launch)`, fans `killByLaunchId` out, throws at spawn naming an unregistered kind; `src/main.ts` builds it around `ClaudeCodeRunner`
- [x] 2.2 `test/loop/harness.ts`: `h.runners` per kind behind a `MultiRunner`, `h.runner` the claude-code fake; `test/runner/multi.test.ts`; `test/loop/health.test.ts`: usage per kind
- [x] 2.3 `briefInput` passes `runner: { kind }` and gives the allow list only to claude-code launches

## 3. Claim by kind

- [x] 3.1 `claim()` takes `runner` (one kind or a list), filters, 404s when none match, 409s a named task of another kind; `POST /v1/claims` and the MCP `claim` tool forward it; `status.claimableByKind` and the digest's `claimableByKind`
- [x] 3.2 `hosts/claude-code/workflows/work.js` claims with `runner "claude-code"` and reads `claimableByKind["claude-code"]`; pinned in `test/host/package.test.ts`; `test/slice/claim.test.ts` covers the filter, the 404, the 409, and the counts

## 4. Finish

- [x] 4.1 Spec deltas for model-selection, worker-runners, pull-runner, operator-control, crash-recovery; `openspec/specs/` is updated when the change is archived
- [x] 4.2 `npm ci --ignore-scripts && npm run build && npx vitest run --retry 2`
