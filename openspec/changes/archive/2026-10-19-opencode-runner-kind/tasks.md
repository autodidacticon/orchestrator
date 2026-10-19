## 1. Implementation

- [x] 1.1 `RUNNER_KINDS` gains `'opencode'`; `EFFORT_LEVELS_BY_KIND.opencode = ['low','medium','high','xhigh','max']` with `EFFORT_FALLBACK.opencode = { ultra: 'max' }` (the set is a pass-through to `--variant`; the CLI decides per model). `DEFAULT_MODEL_BY_KIND.opencode = 'anthropic/claude-opus-5-5'`: the same model the claude-code kind defaults to, reached through the user's OpenCode Anthropic login; a decision, not a probed fact, and the e2e pins `opencode/big-pickle` explicitly.
- [x] 1.2 Model shape per kind: `MODEL_PATTERN` stays for claude-code and codex; `OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/` adds exactly one `/` and nothing else that could escape the shell template. `isModelNameFor(kind, s)` and `modelSchemaFor(kind)` beside the existing `isModelName`/`modelSchema`; graph load, import and the task `runner:`/`model:` selectors use the kind-aware check once the kind is known, the kind-neutral check otherwise (a model carrying `/` is accepted at the shape stage and refused at preparation when the kind is not opencode).
- [x] 1.3 `runner.opencode` in src/config.ts: `model`, `effort`, `commit` (`agent` | `daemon`, default `agent`: no sandbox stands between the agent and git), `command` (template override), `permission` (`derived` | `allow`, default `derived`; semantics in the runner issue), `dataDir` (`shared` | `launch`, default `shared`), `ignoreUserConfig` (default false), `pure` (default true), `snapshots` (default false). Namespace `opencode` in resolve.ts with leaves `model, effort, commit, command, permission, dataDir`; `OVERRIDABLE_KEYS` gains `opencode`; the resolved record and `status.config` carry it with `source` like the codex leaves.
- [x] 1.4 Keep `commitPolicyFor` reading the kind's own `commit` leaf; `derivedCommit` applies to codex only.

## 2. Record

- [x] 2.1 Spec edits landed in 05b7b6d; change directory reconstructed at archive time
