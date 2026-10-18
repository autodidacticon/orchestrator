## 1. Selector

- [x] 1.1 `src/graph/load.ts`: `runner` in the node schema, one of `RUNNER_KINDS`
- [x] 1.2 `src/import/mapping.ts`: the `runner:` label beside `model:` and `effort:`
- [x] 1.3 `src/loop/orchestrator.ts`: `selectionFor` takes the payload `runner` over the run kind
- [x] 1.4 Tests: `test/graph/load.test.ts`, `test/import/mapping.test.ts`, `test/loop/selection.test.ts` (mixed fleet, ultra per kind, status, claim), `test/loop/brief.test.ts` (mixed fleet allow list)

## 2. Finish

- [x] 2.1 Spec deltas for model-selection, graph-import, and worker-runners; `openspec/specs/` is updated when the change is archived, after `runner-dispatch-by-launch`
