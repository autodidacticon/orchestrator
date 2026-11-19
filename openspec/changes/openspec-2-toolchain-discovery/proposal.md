## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `toolchain-discovery`, 8 of the 10 requirements are over the limit (14174 characters and 81 occurrences of SHALL or MUST in all). This change splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-152).

## What Changes

- Eight requirements are MODIFIED. Each keeps its header and every scenario, names and texts unchanged; its description is cut to one behavior of at most 500 characters:

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Resolution order and provenance | 1409 | 459 | 6 | 4 |
  | Toolchain detection | 1459 | 495 | 8 | 6 |
  | Integration branch detection and pinning | 1125 | 472 | 6 | 3 |
  | Derived allowed tools | 2607 | 345 | 8 | 9 |
  | Runner command composition | 2019 | 275 | 5 | 6 |
  | Resolved configuration record | 1276 | 237 | 4 | 5 |
  | Runtime overrides and start-only keys | 2141 | 278 | 9 | 8 |
  | Runtime limit overrides | 2138 | 451 | 7 | 6 |

- 47 requirements are ADDED, one for each behavior moved out of those descriptions. Each has a name `toolchain-discovery` does not have yet, a description of at most 500 characters (the longest is 488), and one scenario of its own with a WHEN and a THEN step. Each scenario states behavior the code has at the base commit fa48e7b; the file that shows it is named below.
- "Node package manager selection" and "Limit leaves in the resolved configuration record" are under the limit and are not touched. Nothing is REMOVED or RENAMED.
- No SHALL or MUST is dropped: the eight original descriptions hold 81; the cut descriptions hold 15 and the ADDED descriptions 79 (94 in all; the extra ones come from the lead-ins repeated in split sentences).

### Splits and lead-ins

Six original sentences do not appear word for word in the new descriptions. Five are longer than 500 characters on their own and are split at their own joints; one has its references made explicit.

- **"Toolchain detection" sentence 1** (1061 characters, the detection table) is split at its semicolons, between rows. Its lead-in "At daemon start the daemon SHALL inspect the repository root, never subdirectories, against this table in this order and SHALL take the check command of the first row that matches:" stays with the `Makefile` and `package.json` rows in the MODIFIED description (495 characters). The table has a precedence, so a later part read alone must not suggest that its first row beats an earlier one: in the three later parts "this table in this order" is made explicit as "the table of "Toolchain detection" in its order", and the part says where its rows sit, naming the requirement that holds the row before them: ", where these rows follow its `package.json` row", ", where these rows follow the `pyproject.toml` row of "Detection rows for Rust, Go and Python"" and ", where these rows follow the `build.gradle` row of "Detection rows for Ruby and Gradle"". Each row keeps its words; the final "." of the sentence ends every part.
  - `Cargo.toml`, `go.mod` and the Python row → **Detection rows for Rust, Go and Python** (475)
  - the `Gemfile` and Gradle rows → **Detection rows for Ruby and Gradle** (488)
  - the `pom.xml`, `mix.exs` and `*.sln`/`*.csproj` rows → **Detection rows for Maven, Elixir and .NET** (442)
- **"Derived allowed tools" sentence 1** (1128 characters) is split at its semicolons, between the items of its list. The list has no precedence, so the lead-in "When the runner kind in force is `claude-code`, the daemon SHALL derive the allow list for the agents it spawns from the toolchains found in the repository root:" is repeated unchanged before each part. The base rules stay in the MODIFIED description (345).
  - the `node` item → **Derived rules for Node** (425)
  - the `rust`, `go` and `python` items → **Derived rules for Rust, Go and Python** (386)
  - the `make`, `ruby`, `gradle`, `maven`, `elixir` and `dotnet` items → **Derived rules for Make, Ruby, Gradle, Maven, Elixir and .NET** (455)
- **"Resolved configuration record" sentence 2** (795 characters) is split between the items of the parenthetical list of configuration keys, at its semicolons. Each part keeps "every configuration key with its value and source (...)" around its items, so the items stay qualified by it, and "whichever kind is in force" stays with the `codex` leaves it qualifies. "The record" is made explicit as "The resolved configuration record" in each part. The list's final "and" before the `codex` leaves is dropped, since that item now stands alone.
  - the resolution time, the repository path, the keys with nested blocks, `runnerKind` and `allowedTools`, and the detection record, the overrides and `needsConfig` → **Configuration record contents** (355)
  - `model` and `effort` of the kind in force with their `applied` rule → **Model and effort in the configuration record** (404)
  - the `codex` leaves → **Codex leaves in the configuration record** (249)
- **"Resolved configuration record" sentence 3** ("The file SHALL be informational: `status` SHALL compute the same facts live and never read the file.") moves whole to **Configuration record is informational**, with "The file" and "the file" made explicit as "`config.json`".
- **"Runtime overrides and start-only keys" sentence 1** (582 characters) has no semicolon. A split between its list items, with the lead-in repeated, would leave a second part with no verb ("... SHALL be overridable while the daemon runs: `allowedTools` and `runnerCommand` to every launch spawned after the change, ..."), which is wrong when read alone. So it is split at its colon, a clause joint, changing only the words at the joint:
  - the head "`checkCommand`, ..., and `codex.command` SHALL be overridable while the daemon runs." stays in the MODIFIED description (278), ended by a full stop in place of the colon;
  - the tail moves to **When a runtime override applies** (329), with "`checkCommand` applies to" turned into "A runtime override of `checkCommand` SHALL apply to"; every other word is kept.
- **"Runtime overrides and start-only keys" sentence 7** (565 characters, the value rules) is split at its semicolon. Its first clause is still 508 characters, so it is split again between the items of its list, before "`codex.sandbox`", with the lead-in "SHALL be" repeated after the item's subject:
  - "`capacity` SHALL be a positive integer, ..., `runnerKind` one of `claude-code` and `codex`." → **Runtime override values** (195)
  - "`codex.sandbox` SHALL be one of `read-only`, ..., and `model` a string matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`." → **Runtime override values for Codex, effort and model** (322)
  - "anything else SHALL be refused with 400 naming the key" → **Runtime override value refusal** (174), with "anything else" made explicit as "A value of an overridable key outside its rule in "Runtime override values" or "Runtime override values for Codex, effort and model"".

Three moved sentences hold no SHALL or MUST, and OpenSpec 2.1 `--strict` refuses an ADDED requirement without one. Each moves word for word beside a sentence with a SHALL: "Only `checkCommand` can be unresolved: ..." with the provenance sentence, "Both keys MAY be set in one patch." with the pair rule, and "The plugin's default mode and the work workflow are decided by the sibling change `add-daemon-lifecycle`, not here." with the sentence on spawned launches.

### Moved sentences

Sentences are numbered from 1 in each original description; a sentence ends at its full stop, so a colon does not end one, and a bullet counts as one sentence. *Unchanged* means word for word. Every sentence not listed as moved stays in its MODIFIED description.

#### Resolution order and provenance

- Sentence 1 ("Every configurable value SHALL be resolved from four layers in this order: ...") stays.
- Sentence 2, unchanged ("A scalar key SHALL take the first layer that supplies it.") → **Scalar and list-valued keys**
- Sentence 3, unchanged ("A list-valued key (`allowedTools`) SHALL compose: ...") → **Scalar and list-valued keys**
- Sentence 4, unchanged ("Every resolved value SHALL record its provenance as ...") → **Provenance of resolved values**
- Sentence 5, unchanged ("Only `checkCommand` can be unresolved: `integrationBranch` defaults to `main`, ...") → **Provenance of resolved values**
- Sentence 6, unchanged ("A key held per runner kind (`model`, `effort`, and the `runner.codex` leaves) SHALL resolve ...") → **Per-kind key resolution**
- Sentence 7, unchanged ("`orchestrator.yaml` SHALL remain optional ...") → **Optional configuration file**

#### Toolchain detection

- Sentence 1 (the detection table), split as described above: the lead-in with the `Makefile` and `package.json` rows stays; the other rows → **Detection rows for Rust, Go and Python**, **Detection rows for Ruby and Gradle**, **Detection rows for Maven, Elixir and .NET**
- Sentence 2, unchanged ("Every row whose manifest is present SHALL be recorded as a found toolchain ...") → **Found toolchains**
- Sentence 3, unchanged ("The detection record SHALL carry the toolchains found, ...") → **Detection record contents**
- Sentence 4, unchanged ("Detection SHALL run once per daemon start and SHALL NOT be repeated while the daemon runs.") → **Detection once per daemon start**

#### Integration branch detection and pinning

- Sentence 1 ("When neither an argument nor the file sets `integrationBranch`, ...") stays.
- Sentence 2, unchanged ("The pin SHALL beat detection and the default silently, ...") → **Pinned branch beats detection**
- Sentence 3, unchanged ("Only an explicit layer that names a different branch ... SHALL conflict with the pin: ...") → **Explicit branch against the pin**
- Sentence 4, unchanged ("The integration branch SHALL apply in every runner mode.") → **Integration branch in every runner mode**

#### Derived allowed tools

- Sentence 1 (the derivation list), split as described above: the lead-in with the base rules stays; the toolchain items → **Derived rules for Node**, **Derived rules for Rust, Go and Python**, **Derived rules for Make, Ruby, Gradle, Maven, Elixir and .NET**
- Sentence 2, unchanged ("Rules from `runner.claude.allowedTools` in the file and from arguments SHALL be appended.") → **Added allow-list rules**
- Sentence 3, unchanged ("`runner.claude.deriveTools: false` SHALL drop the toolchain rules ...") → **Added allow-list rules**
- Sentence 4, unchanged ("A rule containing a double quote, backslash, dollar sign, or backtick SHALL be rejected at configuration time.") → **Unsafe allow-list rules**
- Sentence 5, unchanged ("The list SHALL be passed as `--allowedTools`, ...") → **Allow list beside the repository settings**
- Sentence 6, unchanged ("The derived list SHALL apply only to launches the daemon spawns ...") → **Allow list only for spawned launches**
- Sentence 7, unchanged ("Allow-list composition is specific to `claude-code`: ...") → **No allow list under Codex or OpenCode**
- Sentence 8, unchanged ("The derived `Bash(...)` rules SHALL also feed the OpenCode permission ruleset ...") → **Derived rules in the OpenCode permission ruleset**
- Sentence 9, unchanged ("The plugin's default mode and the work workflow are decided by the sibling change `add-daemon-lifecycle`, not here.") → **Allow list only for spawned launches**

#### Runner command composition

- Sentences 1 ("Each runner kind SHALL have one command template with its own slots.") and 2 ("`DEFAULT_CLAUDE_COMMAND` SHALL be a template with an `{allowedTools}` slot ...") stay, as two paragraphs.
- Sentence 3, unchanged ("At every spawn the Claude Code runner SHALL substitute:") and its three bullets, sentences 4 to 6, unchanged → **Claude Code runner slot substitution**
- Sentence 7, unchanged ("`DEFAULT_CODEX_COMMAND` SHALL carry ...") → **Codex command template**
- Sentence 8, unchanged ("The Codex runner SHALL fill these slots at every spawn alongside the common ones.") → **Codex command template**
- Sentence 9, unchanged ("`DEFAULT_OPENCODE_COMMAND` SHALL carry `{pure}`, `{model}`, and `{variant}` ...") → **OpenCode command template**
- Sentence 10, unchanged ("`hasEffortSlot` SHALL recognise `{effort}` or `{variant}`.") → **OpenCode command template**
- Sentence 11, unchanged ("A runner with slots of its own SHALL compose the whole command through the subprocess runner's `compose` hook ...") → **Composition through the compose hook**
- Sentence 12, unchanged ("Substitution SHALL be one pass over the template ...") → **Composition through the compose hook**
- Sentence 13, unchanged ("A `runnerCommand` (or `runner.codex.command`) from the file or an argument that contains a slot SHALL be filled the same way.") → **Runner command from the file or an argument**
- Sentence 14, unchanged ("One without a slot SHALL run verbatim for that slot, ...") → **Runner command from the file or an argument**
- Sentence 15, unchanged ("The composed command SHALL be read at spawn time, ...") → **Runner command read at spawn time**

#### Resolved configuration record

- Sentence 1 ("The daemon SHALL keep the operator overrides durable in the store under one document and SHALL write the resolved configuration to `<runDir>/config.json` ...") stays.
- Sentence 2 (the record's contents), split as described above → **Configuration record contents**, **Model and effort in the configuration record**, **Codex leaves in the configuration record**
- Sentence 3, references made explicit ("The file" and "the file" → "`config.json`") → **Configuration record is informational**
- Sentence 4, unchanged ("The daemon SHALL append a `config.resolved` event ...") → **Configuration resolved event**

#### Runtime overrides and start-only keys

- Sentence 1, split at its colon as described above: the head stays; the tail → **When a runtime override applies**
- Sentence 2, unchanged ("The override document SHALL keep model and effort per kind, ...") → **Per-kind override document**
- Sentence 3, unchanged ("A stored document holding a flat `model` or `effort`, written before runner kinds, SHALL be read as `claude.*`.") → **Flat model and effort in an old override document**
- Sentence 4, unchanged ("`integrationBranch` SHALL be start-only: ...") → **Start-only integration branch**
- Sentence 5, unchanged ("Setting a key to null SHALL clear its override ...") → **Clearing an override with null**
- Sentence 6, unchanged ("A request that mixes a start-only key with other keys SHALL be refused whole and apply nothing.") → **Start-only integration branch**
- Sentence 7 (the value rules), split as described above → **Runtime override values**, **Runtime override values for Codex, effort and model**, **Runtime override value refusal**

#### Runtime limit overrides

- Sentences 1 ("The launch time budget and the two stuck limits SHALL be durable runtime overrides, ...") and 2 ("The override document SHALL hold them as ...") stay.
- Sentence 3, unchanged ("A value SHALL be an integer from 0 to `Number.MAX_SAFE_INTEGER`; 0 SHALL disable the limit.") → **Runtime limit values**
- Sentence 4, unchanged ("A null leaf SHALL clear that override, and a null block SHALL clear every leaf of the block, ...") → **Runtime limit values**
- Sentence 5, unchanged ("Any other value SHALL be refused naming the dotted key.") → **Runtime limit values**
- Sentence 6, unchanged ("`--set` SHALL read the three values as decimal digits only, ...") → **Runtime limits from --set**
- Sentence 7, unchanged ("Pair rule: a patch that touches `health.stuckAfterMs` or `health.stuckFailAfterMs` ...") → **Stuck limit pair rule**
- Sentence 8, unchanged ("Both keys MAY be set in one patch.") → **Stuck limit pair rule**
- Sentence 9, unchanged ("The refusal SHALL name `health.stuckFailAfterMs` when the patch touches it, ...") → **Stuck limit pair rule**
- Sentence 10, unchanged ("The rule SHALL NOT be evaluated for a patch that touches neither key, ...") → **Stuck limit pair rule outside a patch of the pair**
- Sentence 11, unchanged ("At start, when the pair in force breaks the rule, the daemon SHALL log one warning ...") → **Stuck limit pair rule outside a patch of the pair**
- Sentence 12, unchanged ("A change SHALL apply on the next tick to every live launch, ...") → **When a runtime limit change applies**
- Sentence 13, unchanged ("A stored document with a key the reader does not know SHALL be read as empty, as before.") → **Unknown keys in a stored override document**

### Where each new scenario comes from

At the base commit fa48e7b:

- "A rule added twice is kept once": `src/toolchain/tools.ts` (`composeAllowedTools` attributes each rule to the first layer that contributed it), `test/toolchain/detect.test.ts` ("composes base, detected, file, and argument rules in order, drops duplicates, ...").
- "Only the check command is unresolved": `src/runs/resolve.ts` (`resolveLayers`: `checkCommand` `unresolved` and `needsConfig`; the default leaves), `src/toolchain/branch.ts` (no branch on a detached head without `origin/HEAD`).
- "Flat model reports the kind in force": `src/runs/resolve.ts` (`model` is the leaf of the kind in force), `test/loop/config.test.ts` ("selects the runner kind at runtime, ...": `model` `gpt-6-astra` with source `default` under codex).
- "Start without a file": `test/slice/config.test.ts` ("writes config.json at boot ...": a repository with a `Makefile` and no `orchestrator.yaml` starts with `make test` from `detected` and `capacity` 2 from `default`).
- "Python with Poetry", "Gradle with a wrapper", "Maven with a wrapper", "A later row is found but supplies nothing", "Nothing recognised": `src/toolchain/detect.ts` (`detectToolchain`).
- "A manifest added while the daemon runs": `src/runs/runDir.ts` (`detectRepo` at resolution), `src/loop/orchestrator.ts` (`effective` and `setConfig` resolve against `boot.inputs`, the detection made at start).
- "Another branch checked out on an untouched run", "Explicit layer naming the pinned branch", "Pinned branch in pull mode": `src/runs/resolve.ts` (argument, file, pinned, detected, default), `src/main.ts` (the pin check refuses or re-pins only when the resolved branch differs from the pin; the run mode does not enter the resolution), `test/slice/config.test.ts` ("... keeps the pinned branch against detection ...").
- "pnpm rules derived", "Python with Poetry rules derived", "Maven and Elixir rules derived", "Derivation off with nothing added": `src/toolchain/tools.ts` (`rulesFor`, `composeAllowedTools`), `test/toolchain/detect.test.ts` ("derives the exact Node list, every toolchain of a polyglot root, and the Python runner rule").
- "Rule with a dollar sign refused through the route": `src/toolchain/tools.ts` (`isSafeRule` refuses any `$`), `src/runs/resolve.ts` (the override schema's `rule` refines with `isSafeRule`), `test/loop/config.test.ts` ("refuses invalid values with 400 naming the key, the unsafe rule, ...").
- "Default template passes the list as a flag": `src/runner/command.ts` (`DEFAULT_CLAUDE_COMMAND`).
- "Unclaimed launch spawned in mixed mode": `src/main.ts` (the Claude Code runner reads `allowedTools` from the effective configuration at every spawn), `src/runner/subprocess.ts`, `test/loop/modes.test.ts` ("mixed spawns a parked launch after its window; spawn mode never parks").
- "No list under OpenCode": `src/runs/resolve.ts` (allow-list composition is claude-code only).
- "Rules other than Bash give no pattern": `src/runner/opencode.ts` (`bashPatterns`), `test/runner/opencode.test.ts` ("maps derived rules to bash patterns").
- "Rules quoted into the slot": `src/runner/command.ts` (`DEFAULT_CLAUDE_COMMAND`, `quoteRules`, `substitute`), `test/toolchain/compose.test.ts` ("fills the default template with the Node list in order, each rule double-quoted": `{mcpConfig}` and `{brief}` filled, each rule double-quoted after `--allowedTools`).
- "Codex slots of its own", "Variant slot counts as the effort slot": `src/runner/command.ts` (`DEFAULT_CODEX_COMMAND`, `hasEffortSlot`), `test/toolchain/compose.test.ts` ("fills the Codex template slots and has no allow-list slot").
- "Substituted value not re-substituted": `src/runner/command.ts` (`substitute`), `test/runner/codex.test.ts` ("substitute() leaves a TOML inline table untouched").
- "Slot-less command run verbatim", "Allow list read from the getter at each spawn": `test/toolchain/compose.test.ts` ("the subprocess runner fills the slot from its getter at spawn and runs a slot-less command verbatim").
- "Record lists the allow list parts", "Applied follows the slot": `src/runs/resolve.ts` (`reportOf`), `test/slice/config.test.ts` ("writes config.json at boot ...": `model` and `effort` with `applied: false` under a slot-less `runnerCommand`).
- "Codex leaves under Claude Code": `src/runs/resolve.ts` (`reportOf` carries `codex` whichever kind is in force).
- "Status without the file": `src/loop/orchestrator.ts` (`status` and `configReport` compute from `effective()`; `readConfigJson` is not on that path).
- "Event at start": `src/main.ts` (`config.resolved` with `configSummary` at start), `src/runs/resolve.ts` (`configSummary`).
- "Allowed tools apply to the next spawn": `src/main.ts` (the runner's `allowedTools` getter), `test/toolchain/compose.test.ts`.
- "Flat model binds to the kind in the same patch": `src/runs/resolve.ts` (`applyOverridePatch` takes the patch's own `runnerKind`; `bindFlat`).
- "Old document read under claude": `src/runs/resolve.ts` (`readOverrides`).
- "Integration branch as a start argument": `src/runs/resolve.ts` (an `integrationBranch` override has source `argument`), `src/main.ts` (the first resolution is pinned).
- "Null clears one namespaced leaf": `test/loop/config.test.ts` ("selects the runner kind at runtime, ...": `codex: { sandbox: null }` keeps `codex.effort`).
- "Empty check command refused", "Model outside the pattern refused", "Unknown runner kind refused": `test/loop/config.test.ts` ("refuses invalid values with 400 ..." and "selects the runner kind at runtime, ...").
- "Null block clears both stuck limits": `src/runs/resolve.ts` (`mergeOverrides`: a null block deletes it; the pair rule passes with the defaults).
- "A limit block as JSON": `src/runs/resolve.ts` (`parseSetFlags`: `health=` as a JSON object, `budgets.maxLaunchMs` as digits).
- "Flag limit raised to the fail limit", "Patch of the budget beside a breaking pair": `src/runs/resolve.ts` (`applyOverridePatch` and `stuckPairProblem`).
- "A change that would end a live launch": `src/loop/orchestrator.ts` (`setConfig` and `wouldEnd`), `test/slice/config.test.ts` ("a limit change that would end a live launch is refused with wouldEnd unless endLive confirms it").
- "Stored document with a future key": `src/runs/resolve.ts` (`readOverrides`: a document the strict schema refuses is read as empty).

## Capabilities

### New Capabilities

### Modified Capabilities

- `toolchain-discovery`: eight long requirements have their descriptions cut to one behavior each; the moved behaviors become 47 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-toolchain-discovery/`. No code changes. The change is archived after the milestone review.
