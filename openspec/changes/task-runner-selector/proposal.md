## Why

The launch row carries a runner kind since `runner-dispatch-by-launch`, but the kind is always the run's. A task can choose its model and effort and nothing else, so a run is one fleet: work that suits Codex and work that suits Claude Code cannot share a graph.

## What Changes

- A task MAY carry `runner` (`claude-code` or `codex`) in its payload. Graph load refuses any other value, naming the node and `runner`.
- The import maps a label `runner:<kind>` to the payload's `runner`, the prefix matched without regard to case, by the same rule as `model:` and `effort:`. An unknown kind sets nothing and is listed under `ignoredLabels`; the label stays in `labels`.
- `selectionFor` takes the task's `runner` over the run kind in force, then resolves `model` and `effort` from the chosen kind's defaults. The per-kind effort check and the fallback apply to the chosen kind: `effort: ultra` is kept on a codex task and becomes `max` (with `effortRequested: ultra`) on a claude-code task.
- Nothing else changes: the row, `launch.created`, `status.liveLaunches[]`, the claim response and its `runner` filter, the dispatch, and the brief (no allow list for a codex launch) already follow the kind on the row.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `model-selection`: `Task selectors` gains the `runner` key; `Resolution fixed at preparation` takes the task's kind over the run's. This delta modifies the text written by `runner-dispatch-by-launch`, so that change is archived first.
- `graph-import`: `Mapping rules` gains the `runner:` label.
- `worker-runners`: `Runner dispatch by launch kind` gains a mixed-fleet scenario. The requirement is added by `runner-dispatch-by-launch`, so that change is archived first.

## Impact

- Code: `src/loop/orchestrator.ts` (`selectionFor`), `src/graph/load.ts`, `src/import/mapping.ts`.
- Behaviour: unchanged for a graph without `runner` keys or `runner:` labels.
