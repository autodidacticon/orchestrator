## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Five of the seven requirements of `model-selection` are over the limit: "Run default model and effort" (1625 characters), "Task selectors" (1136), "Resolution fixed at preparation" (1059), "Profile hold at admission" (1837) and "Profile sources of a task" (683). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-147).

## What Changes

- MODIFIED "Run default model and effort": header and all five scenarios kept unchanged; the description is cut to the resolution of the run default through the configuration layers and the rule that neither key is detected, pinned or start-only. The other behaviors move to four ADDED requirements.
- MODIFIED "Task selectors": header and all seven scenarios kept unchanged; the description is cut to the payload keys, the `runner` rule, the load failure and the run default for a task without a selector. The other behaviors move to two ADDED requirements.
- MODIFIED "Resolution fixed at preparation": header and all nine scenarios kept unchanged; the description is cut to how the launch's `runner`, `model` and `effort` are set and recorded in `launch.created`. The other behaviors move to two ADDED requirements.
- MODIFIED "Profile hold at admission": header and all eight scenarios kept unchanged; the description is cut to when a task has a held profile and when a key is missing. The other behaviors move to five ADDED requirements.
- MODIFIED "Profile sources of a task": header and all three scenarios kept unchanged; the description is cut to the definition of the profile and its sources. The other behaviors move to two ADDED requirements.
- Fifteen ADDED requirements, each with a description of at most 500 characters and scenarios of its own. No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped (47 in the original descriptions, 47 in the cut and ADDED ones). No sentence of the original descriptions is longer than 500 characters, so no sentence is split.

### Moved sentences: "Run default model and effort"

- "The run default SHALL be the model and effort of the kind in force, resolved through the configuration layers ... and the resolved record SHALL carry the source of each." stays, unchanged.
- "Neither key SHALL be detected or pinned, and neither SHALL be start-only." stays, unchanged.
- "The configuration SHALL carry a model and an effort per runner kind (see worker-runners \"Runner kinds and defaults\"): ... each effort defaulting to `medium`." moves to **Per-kind model and effort keys**, unchanged.
- "A model SHALL have its kind's shape: for `claude-code` and `codex` it SHALL match ...; for `opencode` it SHALL be `provider/model`, ... so nothing else reaches the shell template." moves to **Model shape per kind**, unchanged.
- "A file value, a namespaced argument, or a flat argument bound to a kind SHALL be refused naming the key when it lacks the kind's shape; a flat `model` not yet bound to a kind SHALL take either shape and apply only to a kind whose shape it has." moves to **Model shape enforced on configuration values**, unchanged.
- "An argument MAY name a kind's key directly (`claude.model`, `codex.effort`); a flat `model` or `effort` argument SHALL bind to the kind in force when it is written, or to a `runnerKind` in the same patch, so changing the kind later does not carry one kind's model to another." moves to **Kind keys and flat argument binding**, unchanged.

### Moved sentences: "Task selectors"

- "A task MAY carry `runner`, `model`, and `effort` in its payload." stays, unchanged.
- "A present `runner` SHALL be one of the runner kinds (`claude-code`, `codex`, `opencode`)." stays, unchanged.
- "A present value of any other shape SHALL fail graph validation naming the node and the key." stays, unchanged.
- "A task without a selector SHALL use the run default for that key; for `model` and `effort` that is the default of the kind the launch runs under." stays, unchanged.
- "A present `effort` SHALL be one of the levels some runner kind accepts (...); whether the chosen kind accepts it is checked when the launch is prepared, not at load." moves to **Task effort selector levels**, unchanged.
- "A present `model` SHALL have the shape of the task's own `runner` when it declares one, ... and the launch runs that kind's default model." moves to **Task model selector shape**, unchanged.
  The sentence keeps its cross-reference `(see "Run default model and effort")` unchanged; the shape rule it points to now lives in **Model shape per kind**, which the milestone review may choose to name instead.
- "An import `model:` label follows the same rule, and a label refused beside a `runner:` label of another kind is listed as ignored." moves to **Task model selector shape**, unchanged (it follows the sentence whose rule it names).

### Moved sentences: "Resolution fixed at preparation"

- "When a launch is prepared the daemon SHALL set the launch's `runner` ... else the default effort of that kind." stays, unchanged.
- "The daemon SHALL record `runner`, `model`, and `effort`, and `effortRequested` when present, in the `launch.created` event payload." stays, unchanged.
- "The effort SHALL be checked against the chosen kind's effort set before the kind's fallback applies: ... and the level asked for SHALL then be recorded as `effortRequested`." moves to **Effort checked against the chosen kind**, unchanged.
- "The values SHALL NOT change for that launch afterwards: ..." moves to **Launch selection fixed after preparation**, with its reference made explicit: "The values" becomes "The `runner`, `model`, `effort` and, when present, `effortRequested` values set when a launch is prepared" (the values the two sentences before it set and record).

### Moved sentences: "Profile hold at admission"

- "When the profile hold is on (see operator-control \"Profile hold key\"), a task SHALL have a held profile when ... is missing." stays, unchanged.
- "A key SHALL be missing when all three hold: ... has no slot for the key." stays, unchanged.
- "In `pull` and `mixed` mode the slot SHALL NOT be consulted, and the mode SHALL be read every time the rule is evaluated." moves to **Profile hold and the runner mode**, with its references made explicit: "the slot" becomes "the kind's command template slot for a key" and "the rule" becomes "the missing-key rule of \"Profile hold at admission\"".
- "The runner kind SHALL never be a reason to hold." moves to **Profile hold and the runner mode**, unchanged.
- "The hold SHALL narrow task-lifecycle \"Admission\" as the scope filter ... does: a ready task with a held profile SHALL be removed from the `ready` list before admission." moves to **Held task removed before admission**, with "The hold" made explicit as "The profile hold".
- "It SHALL take no capacity, defer no other task and not be listed in `status.deferred`." moves to **Held task removed before admission**, with "It" made explicit as "A task with a held profile".
- "It SHALL stay `unstarted` and SHALL NOT be transitioned, and no launch row and no event SHALL be written for it." moves to **Held task removed before admission**, with the first "It" made explicit as "A task with a held profile".
- "Confirming SHALL be setting: any value of the kind's model or effort from `start`, `configure`, `--set` or `orchestrator.yaml` SHALL end the hold for that key, also when it equals the built-in value." moves to **Confirming a held profile by setting**, unchanged.
- "There SHALL be no confirm call and no new stored state for it." moves to **Confirming a held profile by setting**, with "it" made explicit as "confirming".
- "Only admission SHALL be held." moves to **Profile hold applies to admission only**, unchanged.
- "A waiting task that is resumed, a parked launch, a live launch and a recovery launch of the same attempt SHALL NOT be held." moves to **Profile hold applies to admission only**, unchanged.
- "A retry, and a launch after a release, an unblock or a reopen, come from admission and SHALL be held like a first launch." moves to **Profile hold applies to admission only**, unchanged.
- "The profile hold SHALL NOT be a pause and SHALL NOT be the hold after a gap: `paused` and `stalled` SHALL stay false, and the idle exit SHALL work as for a quiet run." moves to **Profile hold is not a pause**, unchanged.
- "The hold SHALL NOT change any built-in model or effort." moves to **Profile hold is not a pause**, unchanged.

### Moved sentences: "Profile sources of a task"

- "The profile of a task SHALL be the `runner`, `model` and `effort` that `selectionFor` returns for it, each key with a source: ... as resolved for that kind with the stored overrides." stays, unchanged.
- "An in-memory configuration with no file SHALL count as the file for a value that differs from the default." moves to **In-memory configuration as the file source**, unchanged.
- "The sources SHALL be read for every runner kind, the kind in force included, by one rule." moves to **Profile sources for every runner kind**, unchanged.
- "`selectionFor`'s return value, the launch row and `launch.created` SHALL keep their shape." moves to **Profile sources for every runner kind**, unchanged.

### Where the new scenarios come from

Each new scenario states behavior the code has at the change's base commit (00cef1d):

- Per-kind model and effort keys: `test/runner/selection.test.ts` ("defaults runner.opencode and checks its model and effort per kind"), `test/runs/resolve.test.ts` ("defaults to claude-code and resolves codex defaults ..."), `src/config.ts`.
- Model shape per kind: `test/runner/selection.test.ts` ("takes exactly one slash for opencode and none for the other kinds"), `src/runner/selection.ts` (`isModelNameFor`).
- Model shape enforced on configuration values: `test/runner/selection.test.ts` ("defaults runner.opencode ..."), `test/runs/resolve.test.ts` ("resolves the file kind with its defaults, folds the dotted keys, binds a flat provider/model, and refuses one under another kind").
- Kind keys and flat argument binding: `test/runs/resolve.test.ts` ("parses --set flags per key and refuses unknown keys, bad values, and unsafe rules"), `src/runs/resolve.ts` (`parseSetFlags`).
- Task effort selector levels: `src/graph/load.ts` (`nodeSchema`: `effortSchema` with no per-kind check at load), `test/graph/load.test.ts`, `test/loop/selection.test.ts` ("a task runner selector wins over the run kind ...").
- Task model selector shape: `test/runner/selection.test.ts` ("an import label takes a provider/model, and ignores it beside a runner label of another kind").
- Effort checked against the chosen kind: `test/runner/selection.test.ts` ("prepares ultra as max with effortRequested, the opencode default model, and the agent commit policy").
- Launch selection fixed after preparation: `test/loop/selection.test.ts` ("a task selector wins over the run default, the choice is fixed at preparation, and status and the event show it").
- Profile hold and the runner mode: `test/loop/profile-hold.test.ts` ("criterion 11 ..."), `src/loop/orchestrator.ts` (`profileOf`: `missing` holds only `model` and `effort`, never the runner).
- Held task removed before admission: `test/loop/profile-hold.test.ts` ("criteria 2 and 3 ...").
- Confirming a held profile by setting: `test/slice/profile-hold.test.ts` ("criterion 16: a file value equal to the built-in one confirms").
- Profile hold applies to admission only: `test/loop/profile-hold.test.ts` ("criterion 9: only admission is held ...").
- Profile hold is not a pause: `test/loop/profile-hold.test.ts` ("criteria 2 and 3 ...").
- In-memory configuration as the file source: `test/loop/profile-hold.test.ts` ("criterion 10: a file value confirms", run on the harness's in-memory configuration), `src/runs/resolve.ts` (`leaf`).
- Profile sources for every runner kind: `test/loop/profile-hold.test.ts` ("criterion 5: the hold is per kind ..."), `test/runner/selection.test.ts` (`selectionFor` results), `src/loop/orchestrator.ts` (`kindFacts`, `profileOf`).

## Capabilities

### New Capabilities

### Modified Capabilities

- `model-selection`: five long requirements cut to one behavior each; fifteen requirements added for the moved behaviors.

## Impact

Spec text only. No code, test or other capability changes.
