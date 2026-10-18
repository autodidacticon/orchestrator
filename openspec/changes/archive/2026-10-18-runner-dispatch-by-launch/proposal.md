## Why

The daemon holds one hardwired `ClaudeCodeRunner`, so there is nowhere for a Codex runner to be chosen. Without the runner kind on the launch row the daemon cannot pick the right usage parser after a restart, cannot tell a pull worker which CLI to run, and cannot write kind-specific brief text. Choosing the kind at spawn from the configuration in force would break the model-selection invariant that an override reaches only launches prepared afterwards. And without a claim filter a Claude Code worker would take a Codex launch, release it untouched, and the next admission would park it for the same worker again.

## What Changes

- `selectionFor` returns `{ runner, model, effort, effortRequested? }`: the kind in force, the task's `model` over that kind's own default model, and the task's `effort` over that kind's default effort, checked against the kind's effort set before the kind's fallback applies (`ultra -> max` for claude-code). `effortRequested` records the value asked for when the fallback replaced it.
- The launch row carries `runner` (a row without it reads as `claude-code`); `launch.created` carries `runner` (and `effortRequested`); `status.liveLaunches[]` and the claim response carry `runner`.
- New `MultiRunner` holds one runner per kind and routes `spawn`, `alive`, `liveness`, `reap`, and `readUsage` by the launch's kind; `killByLaunchId` goes to every registered runner. A launch whose kind has no runner fails at spawn with an error naming the kind. The daemon constructs `ClaudeCodeRunner` under a `MultiRunner`; the codex slot fills when the Codex runner lands.
- The brief input carries `runner: { kind }`; the allow list goes only to claude-code launches.
- `POST /v1/claims` (and the MCP `claim` tool) take an optional `runner` filter: one kind or a list. A claim skips launches of other kinds, answers 404 when none match, and answers 409 naming the launch's runner for a named task of another kind. `status` gains `claimableByKind` beside `claimable`; the event digest carries it too. The work workflow claims with `runner: "claude-code"` and counts only those launches as claimable.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `model-selection`: `Resolution fixed at preparation`, `Runners and workers receive the values`, `Selection visible to operators` gain the kind, the per-kind defaults, the fallback, and `effortRequested`.
- `worker-runners`: ADDED `Runner dispatch by launch kind`.
- `pull-runner`: `Claim` gains the `runner` filter, the 409 for a named task of another kind, and `runner` in the response.
- `operator-control`: `Status report` gains `claimableByKind`.
- `crash-recovery`: `Launch lifecycle records` names the kind on the row.

## Impact

- Code: `src/runner/multi.ts` (new), `src/runner/selection.ts` (`Selection`), `src/loop/orchestrator.ts`, `src/loop/core.ts`, `src/launch/launch.ts`, `src/state/store.ts` (`Launch.runner`, `runnerOf`), `src/workspace/workspace.ts` (`BriefInput.runner`), `src/main.ts`, `src/operator/routes.ts`, `src/operator/mcp-server.ts` (`claim` takes `runner`), `src/index.ts`, `hosts/claude-code/workflows/work.js`, `test/loop/harness.ts` (`h.runners`).
- Behaviour: unchanged for a claude-code run apart from the new fields. A claim without `runner` behaves as before.
