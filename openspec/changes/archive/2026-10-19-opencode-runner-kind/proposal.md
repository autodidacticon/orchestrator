## Why

Nothing downstream can name the kind, carry its settings, or accept its model ids. The runner (next issue), the operator surfaces and the brief all read `runner.opencode.*` and `RUNNER_KINDS` from here.

## What Changes

1. `RUNNER_KINDS` gains `'opencode'`; `EFFORT_LEVELS_BY_KIND.opencode = ['low','medium','high','xhigh','max']` with `EFFORT_FALLBACK.opencode = { ultra: 'max' }` (the set is a pass-through to `--variant`; the CLI decides per model). `DEFAULT_MODEL_BY_KIND.opencode = 'anthropic/claude-opus-5-5'`: the same model the claude-code kind defaults to, reached through the user's OpenCode Anthropic login; a decision, not a probed fact, and the e2e pins `opencode/big-pickle` explicitly.
2. Model shape per kind: `MODEL_PATTERN` stays for claude-code and codex; `OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/` adds exactly one `/` and nothing else that could escape the shell template. `isModelNameFor(kind, s)` and `modelSchemaFor(kind)` beside the existing `isModelName`/`modelSchema`; graph load, import and the task `runner:`/`model:` selectors use the kind-aware check once the kind is known, the kind-neutral check otherwise (a model carrying `/` is accepted at the shape stage and refused at preparation when the kind is not opencode).
3. `runner.opencode` in src/config.ts: `model`, `effort`, `commit` (`agent` | `daemon`, default `agent`: no sandbox stands between the agent and git), `command` (template override), `permission` (`derived` | `allow`, default `derived`; semantics in the runner issue), `dataDir` (`shared` | `launch`, default `shared`), `ignoreUserConfig` (default false), `pure` (default true), `snapshots` (default false). Namespace `opencode` in resolve.ts with leaves `model, effort, commit, command, permission, dataDir`; `OVERRIDABLE_KEYS` gains `opencode`; the resolved record and `status.config` carry it with `source` like the codex leaves.
4. Keep `commitPolicyFor` reading the kind's own `commit` leaf; `derivedCommit` applies to codex only.

Not in this issue: the runner, the template, the brief text, the CLI flags and configure tool (own issues).

## Capabilities

- `model-selection`: modified: "Run default model and effort", "Task selectors", "Resolution fixed at preparation"
- `operator-control`: modified: "Configuration route", "Start arguments"
- `worker-runners`: modified: "Runner kinds and defaults", "Per-kind effort sets", "Sandbox and commit policy"

## Impact

* src/runner/selection.ts, src/config.ts, src/runs/resolve.ts, src/loop/orchestrator.ts (commitPolicyFor, countByKind), src/graph/ or src/import (selector shape check, where `isModelName` is called)
* test/runner/selection.test.ts (new), test/runs/fold.test.ts, test/slice/config.test.ts

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-57 edited `openspec/specs` directly in commit 05b7b6d instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-57 issue text.

Commit summary: opencode is now the third runner kind. It has its own effort set (passed through as --variant, ultra prepared as max), a default model of anthropic/claude-opus-5-5, and a provider/model id shape that allows exactly one slash. runner.opencode.* is in config.ts with the defaults the brief lists, and resolve.ts has an opencode namespace (model, effort, commit, command, permission, dataDir) that the resolved record and status config carry, each leaf with its source. foldRunnerArgs folds permission and dataDir under opencode. commitPolicyFor reads opencode's own commit leaf; only codex derives its policy. Graph load and import check a model against the task's own runner when it has one, and against any kind's shape otherwise. At preparation, a model that does not fit the chosen kind's shape is not used and the kind's default model runs instead. The three specs are updated. Commit 9a653f2.
