## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Two of the seven requirements of `scheduling-policy` are over the limit: "Ordering chain" (573 characters) and "Scope filter at admission" (671). This change splits each the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-151).

## What Changes

- MODIFIED "Ordering chain": header and all four scenarios kept unchanged; the description is cut to the chain as one stable lexicographic sort and its default (373 characters). The other behaviors move to two ADDED requirements.
- MODIFIED "Scope filter at admission": header and all four scenarios kept unchanged; the description is cut to the walk that skips an overlapping candidate (267 characters). The other behaviors move to two ADDED requirements.
- Four ADDED requirements, each with a description of at most 500 characters and scenarios of its own. No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped: 9 in the original descriptions, 9 in the cut and ADDED ones (4 cut + 5 ADDED). No sentence of the original descriptions is longer than 500 characters, so no sentence is split, and no reference needed to be made explicit.
- The sentence that defines when a task holds its scope has no SHALL of its own, and OpenSpec 2.1 warns on an ADDED requirement without SHALL or MUST (a warning that fails `--strict`). Kept in "Scope filter at admission" it would bring that description to 504 characters, so it moves together with the deferral-record sentence into one ADDED requirement, **Held scopes and deferral record**.

### Moved sentences: "Ordering chain"

- "The orchestrator SHALL order ready candidates for admission by a configurable chain of stages, `scheduling.order`, applied as one stable lexicographic sort: the first stage decides, each later stage breaks ties left by the stages before it, and candidates still tied after the last stage keep graph file order." stays, unchanged.
- "The default chain SHALL be `criticalPath`, `priority`, `fifo`." stays, unchanged.
- "Resumable waiting tasks SHALL be admitted before any ordered candidate and SHALL NOT be ordered by the chain." moves to **Resumable tasks ahead of the ordering chain**, unchanged.
- "A stage name that is not registered SHALL fail configuration validation naming the stage." moves to **Unregistered ordering stage**, unchanged.

### Moved sentences: "Scope filter at admission"

- "When `scheduling.scopes` is enabled, which is the default, the orchestrator SHALL walk the ordered candidates and SHALL skip for this tick any candidate whose scope overlaps the scope of a task that holds its scope or of a candidate admitted earlier in the same pass." stays, unchanged.
- "A task holds its scope while it is `running`, `waiting`, or `submitted`, and while it has a claimable launch; it releases it when its work is published or when it leaves those states for `failed`, `blocked`, `cancelled`, or `unstarted`." moves to **Held scopes and deferral record**, unchanged.
- "A skipped candidate SHALL be recorded as deferred with reason `scopeOverlap` and the ids it overlaps." moves to **Held scopes and deferral record**, unchanged.
- "When `scheduling.scopes` is disabled, nothing SHALL be deferred." moves to **Scope filter disabled**, unchanged.

### Sources of the new scenarios (at base d011649)

- **Resumable tasks ahead of the ordering chain**, "Resumed task takes a slot before ordered candidates": `test/loop/schedule.test.ts` ("resumables take free slots first and are not ordered"), `src/loop/schedule.ts` (`admit`).
- **Unregistered ordering stage**, "Unregistered stage after a registered one": `test/loop/schedule.test.ts` ("an unknown stage fails config validation naming it"), `src/config.ts` (`scheduling.order` as `z.enum(stageNames)`).
- **Held scopes and deferral record**, "Blocked blocker releases its scope": `test/loop/scenarios.test.ts` ("a waiting blocker holds its scope; a failed one releases it").
- **Held scopes and deferral record**, "Released claimable launch releases its scope": `test/loop/scenarios.test.ts` ("a claimable launch holds its scope in pull mode").
- **Held scopes and deferral record**, "Every overlapping id listed": `test/loop/schedule.test.ts` ("records deferrals even when capacity is already full and lists every overlapping id"), `src/loop/schedule.ts` (`Deferral`, `admit`).
- **Scope filter disabled**, "Overlapping tasks admitted together": `test/loop/scenarios.test.ts` ("scopes: false launches overlapping tasks together; a paused run reports nothing deferred"), `test/loop/schedule.test.ts` ("unconstrained tasks never conflict; scopes: false defers nothing").

## Capabilities

### New Capabilities

### Modified Capabilities

- `scheduling-policy`: "Ordering chain" and "Scope filter at admission" cut to one behavior each; four requirements added for the moved sentences.

## Impact

Spec text only; no code changes.
