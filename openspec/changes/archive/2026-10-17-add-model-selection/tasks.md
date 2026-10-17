## 1. Configuration, validation, and resolution

- [x] 1.1 New `src/runner/selection.ts`: `EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']`, `DEFAULT_MODEL = 'claude-opus-5-5'`, `DEFAULT_EFFORT = 'medium'`, `MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/`, `isModelName(s)`, `isEffort(s)`, zod schemas `modelSchema` and `effortSchema`; export from `src/index.ts`
- [x] 1.2 `src/config.ts`: `runner.claude` gains `model: modelSchema.default(DEFAULT_MODEL)` and `effort: effortSchema.default(DEFAULT_EFFORT)`
- [x] 1.3 `src/runs/resolve.ts`: add `model` and `effort` to `OVERRIDABLE_KEYS` and `overridesSchema` (value or null); `fileClaude` reads `model` and `effort` from the file's `runner.claude`; resolve each as argument over file over default with provenance; `Resolved` gains `model: { value, applied }` and `effort: { value, applied }` where `applied` is whether the effective `runnerCommand` contains `{model}` / `{effort}`; `reportOf` and `configSummary` emit `model` and `effort` leaves as `{ value, source, applied }`; `parseSetFlags` accepts `model=` and `effort=` and refuses bad values naming the key
- [x] 1.4 `src/runner/command.ts`: `MODEL_SLOT = '{model}'`, `EFFORT_SLOT = '{effort}'`, `DEFAULT_CLAUDE_COMMAND` carries `--model {model} --effort {effort}` after the allow list, `hasModelSlot(template)`, `hasEffortSlot(template)`
- [x] 1.5 Tests: `test/runs/resolve.test.ts`: defaults with source `default`; file beats default and argument beats file for each key; null clears to the next layer; `applied` false for a slot-less `runnerCommand`; `parseSetFlags` accepts `effort=high` and refuses `effort=huge` and `model=opus;rm` naming the key; `config.json` round-trips the new leaves

## 2. Task selectors in the graph and the import

- [x] 2.1 `src/graph/load.ts`: the node schema gains optional `model: modelSchema` and `effort: effortSchema`, both staying in the payload like `scope`; the validation error names the node and the key
- [x] 2.2 `src/import/mapping.ts`: `payloadOf` scans `labels` for a case-insensitive `model:` or `effort:` prefix, sets the payload key when the value passes `isModelName` / `isEffort`, keeps the label in `labels`, and otherwise pushes `{ id, label }` to a new `ImportSummary.ignoredLabels`; the `import` MCP tool and the CLI print `ignoredLabels` with the rest of the summary
- [x] 2.3 Tests: `test/graph/load.test.ts`: selectors load into the payload; `effort: huge` and `model: "opus; rm -rf /"` are refused naming the node and the key; `test/import/mapping.test.ts`: `Effort:low` and `model:claude-sonnet-5-5` map and stay in `labels`; `effort:huge` is left as a label and listed in `ignoredLabels` with the issue id

## 3. Resolution at preparation, the runner, and the claim

- [x] 3.1 `src/state/store.ts`: `Launch` gains optional `model` and `effort` (JSON document fields; no schema change); `src/launch/launch.ts` `prepareLaunch` sets both from the node payload over `core.effective()` and includes them in the `launch.created` event payload
- [x] 3.2 `src/runner/subprocess.ts`: `substitute` variables gain `model: launch.model ?? ''` and `effort: launch.effort ?? ''`; `src/loop/orchestrator.ts` `claimResponse` adds `model` and `effort`; `status()` adds them to each `liveLaunches` entry; `StatusReport` typed accordingly
- [x] 3.3 `src/loop/orchestrator.ts` `effective()` exposes `model` and `effort` with `applied`; `configReport()` and `setConfig` cover the new keys (validation through `overridesSchema`, same 400 path); the `effective` memo key already covers the kv document
- [x] 3.4 Tests: `test/loop/config.test.ts`: `setConfig({ effort: 'huge' })` is 400 naming `effort`; `setConfig({ model: 'claude-sonnet-5-5' })` applies with source `argument`; `test/loop/brief.test.ts` or a new `test/loop/selection.test.ts` over the harness: a task with `effort: high` gets a launch with `effort: high` while another gets the default; an override set after T1 was prepared reaches T2 only; a retry prepared after an override takes the new value; `launch.created` carries both; `status.liveLaunches` shows them; `test/toolchain/compose.test.ts`: the default template filled contains `--model claude-opus-5-5 --effort medium`; `test/slice/claim.test.ts`: the claim response carries `model` and `effort`; `test/slice/launch.test.ts`: a scripted `runnerCommand` echoing `{model} {effort}` shows the task's values

## 4. Operator surfaces

- [x] 4.1 `src/operator/routes.ts`: `PUT /v1/config` accepts `model` and `effort` (through `overridesSchema`, nothing else to add); `GET /v1/config` and the no-graph status branch carry the new leaves via `configReport()`
- [x] 4.2 `src/operator/cli.ts`: `config --model <name>` and `config --effort <level>`; usage text; `start --set model=...` and `--set effort=...` already flow through `parseSetFlags`
- [x] 4.3 `src/runs/lifecycle.ts`: `StartOptions.overrides` accepts the new keys (typed from `Overrides`); `applyOverrides` needs no change beyond the type
- [x] 4.4 `src/operator/mcp-server.ts`: `start` input schema gains `model` and `effort` with descriptions; `configure` schema gains both (nullable); `status` description mentions per-launch `model` and `effort`; descriptions name the defaults and the five effort levels
- [x] 4.5 Tests: `test/slice/config.test.ts`: `PUT /v1/config { effort: "high" }` applies and the next prepared launch has it, `{ effort: "huge" }` is 400; `orchestrator-ctl config --effort high` sets it; daemon `--set effort=huge` exits with a usage error before serving; `test/slice/operator-mcp.test.ts`: `configure` lists `model` and `effort` in its schema and `start` with `model` returns `config.model` with source `argument`

## 5. Plugin workflow and skills

- [x] 5.1 `hosts/claude-code/workflows/work.js`: `CLAIM_SCHEMA` gains optional `model` and `effort`; `claimPrompt` returns them from the claim response; the worker `agent()` call passes `{ model: c.model, effort: c.effort }` when present
- [x] 5.2 `hosts/claude-code/skills/run/SKILL.md` and `work/SKILL.md`: the toolchain line names the worker model and effort with sources ("workers claude-opus-5-5 at medium (default)"), omitted when `config.model.applied` is false; `configure` documented with `model` and `effort`
- [x] 5.3 `hosts/claude-code/skills/import/SKILL.md`: document the `model:<name>` and `effort:<level>` labels under the issue record section and report `ignoredLabels` to the user after import
- [x] 5.4 Tests: `test/host/package.test.ts` (or the existing skill-content checks): `work.js` passes `model` and `effort` to the worker agent; the three skills mention the model line; `test/e2e/work.test.ts` prompt unchanged (opt-in run to confirm a worker honours a task's `effort: low`)

## 6. Documentation and finish

- [x] 6.1 README: the configuration section names `runner.claude.model` and `runner.claude.effort` with their defaults, the `model:` and `effort:` labels, and the `--model`/`--effort` slots in `runnerCommand`; the Contents index gains `model-selection` and the toolchain-discovery line mentions model and effort
- [x] 6.2 `npm run build`, `npm test`; confirm `dist/` is current and the plugin's bundled workflow is the edited file
