## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Two of the twelve requirements of `graph-import` are over the limit: "Mapping rules" (1467 characters) and "Tracker record" (722 characters). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-150).

## What Changes

- MODIFIED "Mapping rules": header and all eight scenarios kept unchanged; the description is cut to the mapping of open children, dependencies and the milestone. The other behaviors move to six ADDED requirements.
- MODIFIED "Tracker record": header and all five scenarios kept unchanged; the description is cut to accepting and passing `tracker` with the mapping unchanged. The other behaviors move to three ADDED requirements.
- Nine ADDED requirements, each with a description of at most 500 characters and scenarios of its own. No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped.

### Moved sentences: "Mapping rules"

Two sentences of the original are each longer than 500 characters on their own, so they are split at their semicolons; every clause keeps its words.

- "The import SHALL map: every child of the root with state `open` to a task whose id is the tracker key; every `blockedBy` edge between two tasks to a dependency; every `blockedBy` target outside the child set, and every child with state `done`, `cancelled`, or `inProgress`, to an `external` node whose `done` flag is true for state `done` and for state `cancelled` (work that is finished or will never happen; either way nothing waits on it) and false for `inProgress` and for an outside blocker that is still open; and the root to a gated milestone depending on every child."
  - Its first, second and last clauses stay in "Mapping rules".
  - Its clause on `external` nodes moves to **External nodes from the import**, with "The import SHALL map" repeated as its subject.
- "Node payloads SHALL carry `title`, `description`, `acceptanceCriteria`, `labels`, `priority`, `url`, and `trackerState`." moves to **Node payload fields**, unchanged.
- "A label `model:<value>` SHALL set the payload's `model` to `<value>`, ... (for `runner`, one of the runner kinds); the label SHALL stay in `labels` either way, and a label whose value fails the rule SHALL set nothing and SHALL be listed in the import summary under `ignoredLabels` with its issue id."
  - The part before the semicolon moves to **Selector labels set payload keys**, unchanged, ending with a period.
  - The part after it moves to **Selector labels kept and failures listed**, with its references made explicit: "the label" becomes "A `model:`, `effort:` or `runner:` label", "either way" becomes "whether or not its value satisfies the model-selection shape rules", and "the rule" becomes "those rules".
- "The milestone SHALL carry the root's `description` and `acceptanceCriteria` when the root record has a description, so that a review shows what the milestone must satisfy." moves to **Milestone carries the root's criteria**, unchanged.
- "The in-progress rule SHALL be configurable to import such issues as tasks instead." moves to **Configurable in-progress rule**, with "such issues" made explicit as "issues with state `inProgress`".

### Moved sentences: "Tracker record"

- "`import_issues` SHALL accept an optional `tracker` ... with the mapped graph." stays in "Tracker record", unchanged.
- "The mapping SHALL be unchanged by `tracker`." stays in "Tracker record", unchanged.
- "For `github`, `workspace` SHALL be the repository as `owner/repo`, and `inProgressLabel` MAY name the label that stands for the in-progress state; the field SHALL be refused for other kinds." moves to **GitHub tracker fields**, with "the field" made explicit as "the `inProgressLabel` field".
- "When present, the route SHALL record the tracker in the store under the key `tracker` and SHALL append a `tracker.recorded` event; when absent, a previously recorded tracker SHALL remain in force." moves to **Tracker stored at import**, with its references made explicit: "When `tracker` is present, the `import` route ...; when `tracker` is absent, ...".
- "`status` and the outbox policy SHALL report the recorded tracker including `inProgressLabel`." moves to **Tracker reported to drainers**, unchanged.

### Where the new scenarios come from

Each new scenario states behavior the code has at the change's base commit:

- External nodes from the import, Node payload fields: `test/import/mapping.test.ts` ("maps an epic with mixed children"), `src/import/mapping.ts` (`addExternal`, `payloadOf`).
- Selector labels set payload keys, Selector labels kept and failures listed: `test/import/mapping.test.ts` ("model: and effort: labels set the selectors ..."), `src/import/mapping.ts` (`selectorsOf`).
- Milestone carries the root's criteria: `test/import/mapping.test.ts` ("the root's description and acceptance criteria ride on the milestone").
- Configurable in-progress rule: `test/import/mapping.test.ts` ("in-progress policy and ungated option").
- GitHub tracker fields, Tracker stored at import, Tracker reported to drainers: `test/slice/outbox.test.ts` (the tracker record part of the import route test), `src/operator/routes.ts` (`PUT /v1/graph`).

## Capabilities

### New Capabilities

### Modified Capabilities

- `graph-import`: "Mapping rules" and "Tracker record" are split; nine requirements are added from their descriptions.

## Impact

Spec text only. No code, test or other spec changes.
