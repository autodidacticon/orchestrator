## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. In `health-monitoring`, 10 of the 15 requirements are over the limit. This change, part 2 of 2 of the OpenSpec 2.1 migration of `health-monitoring` (task ORC-173, under ORC-139), splits 5 of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. The other long requirements are split by `openspec-2-health-monitoring-1`, which touches disjoint requirements.

## What Changes

- Five requirements are MODIFIED. Each keeps its header and every scenario, names and text unchanged. Its description is cut to one behavior of at most 500 characters. Lengths are measured as OpenSpec 2.1 measures them (non-blank lines trimmed and joined by newlines); the Facts of the brief measure the raw text, which gives 2190, 2663 and 7271 in all where this table gives 2189, 2658 and 7265.

  | Requirement | Before | After | Scenarios kept | ADDED from it |
  |---|---|---|---|---|
  | Run cost budget | 2189 | 321 | 5 | 6 |
  | Worktree observation takes no index lock | 633 | 302 | 3 | 1 |
  | Gap in the daemon's clock | 2658 | 305 | 6 | 10 |
  | Hold after a gap | 941 | 405 | 4 | 3 |
  | Limits read at every check | 844 | 460 | 5 | 1 |

- 21 requirements are ADDED, each holding behavior moved out of one of those descriptions. Each is named "<MODIFIED name>: <behavior>", a name `health-monitoring` does not have yet; each has a description of at most 500 characters (83 to 491) that holds SHALL or MUST, and at least one scenario of its own with a WHEN and a THEN step, based on a test or source file at the base (listed below).
- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened: the five original descriptions hold 57; the cut descriptions hold 16 and the ADDED descriptions 42 (58 in all). The one extra SHALL is the one given at a joint in "Run cost budget" (see Splits).
- The ten other requirements of `health-monitoring` are not touched, and no file outside this change directory changes. The change is archived after the milestone review.
- This change makes none of the fixes of ORC-163 ("Usage accounting"); the sentence of "Gap in the daemon's clock" that excepts "Usage accounting" moves unchanged.

### Splits, explicit references and SHALL at a joint

Only one original sentence is longer than 500 characters on its own: the pricing sentence of "Run cost budget" (557 characters with its five-item list and its tail "each count divided by one million and the total rounded to 1e-6."). It is split at its last semicolon, the one that closes the list's last item, so the list stays whole and each part is right when read alone:

- The first part, the lead-in and all five items, moves to **Run cost budget: priced cost** (491 characters); the semicolon that closed the last item ("- `reasoningOutput` at `reasoningOutputPerMTok`, falling back to `outputPerMTok`;") becomes a period.
- The second part, the tail, has no SHALL or MUST of its own and no SHALL sentence can carry it within 500 characters beside the first part, so it gets SHALL plus its own verb at the joint, and its reference to the sum is made explicit: "each count divided by one million and the total rounded to 1e-6." becomes "In the priced cost of "Run cost budget: priced cost", each count SHALL be divided by one million and the total rounded to 1e-6." It moves to **Run cost budget: priced cost units and Codex counts**.

Every other change of wording is a reference made explicit:

- "Worktree observation takes no index lock": "The progress fingerprint SHALL therefore use ..." becomes "So that the daemon's read-only git commands never write a launch worktree's index, the progress fingerprint SHALL use ...", the "therefore" (which pointed at the sentence before it, left in the MODIFIED description) made explicit; the rest of the sentence is unchanged.
- "Gap in the daemon's clock": "With no gap every value SHALL equal what wall time gives." becomes "With no gap every value measured in awake time SHALL equal what wall time gives.", "every value" made explicit (it named the values the requirement measures in awake time, not the wall-time clocks of the sentence before it).

No lead-in is added. Five original sentences have no SHALL or MUST of their own; each moves unchanged beside a SHALL sentence that carries it within 500 characters, so none gets a SHALL:

- "Two assumptions about Codex's counts are assumed, unverified: ..." travels with the tail of the pricing sentence in **Run cost budget: priced cost units and Codex counts** (the assumptions are about the counts that sentence divides).
- "This excepts operator-control "Idle exit", whose list of what counts as activity does not name it." stays with the sentence it qualifies in **Gap in the daemon's clock: idle exit**.
- "No status field reports gaps or the hold." travels with the `idleMs`/`elapsedMs` sentence in **Gap in the daemon's clock: status times**.
- "Idle and elapsed time are measured as ...; only the limit they are compared with follows the override." and "A change that lands while the tick is already ending a launch does not save it." travel with "A raised limit SHALL keep ..." in **Limits read at every check: raised and lowered limits**; the second is the exception to that sentence and stays in the same requirement as it.

The scripted check prints exactly these four sentences as not found word for word in the delta, and every other original sentence or list item (49 of 53) as found word for word in exactly one requirement.

## Moved sentences

Sentences are numbered from 1 in each original description; a list item counts as one. Every sentence not listed stays word for word in its MODIFIED description. *Unchanged* means word for word.

### Run cost budget

Stays: 1 ("Config `budgets.maxRunCostUsd` (default 0) SHALL mean unlimited when 0."), 14 ("The ceiling SHALL be ..."), 15 ("When the run cost reaches the ceiling, admission SHALL pause ..."). The pricing sentence is numbered as its lead-in (4), its five items (5 to 9) and its tail (10).

- 2 "Config `budgets.prices` (default `{}`) SHALL map a model name (checked by the model-name pattern) to rates in USD per million tokens: ..." → **Run cost budget: model prices**, unchanged.
- 3 "When a runner reports a cost, the launch SHALL record it with `costSource: 'reported'` and SHALL NOT re-price it." → **Run cost budget: reported cost**, unchanged.
- 4 "When a runner reports tokens without a cost and `budgets.prices` has the launch's model, the daemon SHALL compute `costUsd` at record time with `costSource: 'priced'` as the sum of:" (the lead-in) → **Run cost budget: priced cost**, unchanged.
- 5 "- `input - cachedInput` at `inputPerMTok`;" → **Run cost budget: priced cost**, unchanged.
- 6 "- `cachedInput` at `cachedInputPerMTok`, falling back to `inputPerMTok`;" → **Run cost budget: priced cost**, unchanged.
- 7 "- `cacheWriteInput` at `cacheWriteInputPerMTok`, falling back to `inputPerMTok`;" → **Run cost budget: priced cost**, unchanged.
- 8 "- `output` at `outputPerMTok`;" → **Run cost budget: priced cost**, unchanged.
- 9 "- `reasoningOutput` at `reasoningOutputPerMTok`, falling back to `outputPerMTok`;" → **Run cost budget: priced cost**, split: its closing semicolon becomes a period (see Splits).
- 10 (the tail) "each count divided by one million and the total rounded to 1e-6." → **Run cost budget: priced cost units and Codex counts**, split, with SHALL at the joint and its reference made explicit: "In the priced cost of "Run cost budget: priced cost", each count SHALL be divided by one million and the total rounded to 1e-6."
- 11 "Two assumptions about Codex's counts are assumed, unverified: `cached_input_tokens` is a subset of `input_tokens` (...), and `reasoning_output_tokens` is NOT included in `output_tokens`." → **Run cost budget: priced cost units and Codex counts**, unchanged.
- 12 "When tokens are reported without a cost and the model has no price, the launch's cost SHALL stay unknown: ..." → **Run cost budget: unpriced launches**, unchanged.
- 13 "The run cost, and so the ceiling, SHALL count priced and reported launches only; unpriced launches SHALL NOT pause admission." → **Run cost budget: unpriced launches**, unchanged.
- 16 "`resume` SHALL be refused while the run cost is at or above the ceiling unless called with `overrideBudget`, ..." → **Run cost budget: resume over the ceiling**, unchanged.

### Worktree observation takes no index lock

Stays: 1 ("The daemon's git commands SHALL run with `GIT_OPTIONAL_LOCKS=0`."), 2 ("Its read-only git commands against a launch worktree SHALL never write ..."), 4 ("Commands that write SHALL take their locks as before.").

- 3 "The progress fingerprint SHALL therefore use `git status --porcelain`, ...; it SHALL NOT use porcelain `git diff`, ..." → **Worktree observation takes no index lock: fingerprint commands**, reference made explicit ("therefore" becomes "So that the daemon's read-only git commands never write a launch worktree's index,").

### Gap in the daemon's clock

Stays: 1 ("A *note* SHALL be ..."), 2 ("A *gap* SHALL be ..."), 3 ("*Awake time* between two instants SHALL be ...").

- 4 "The configuration SHALL accept `health.gapAfterMs` and `health.gapHoldMs`, ...; `gapAfterMs: 0` SHALL turn the whole rule off, ..." → **Gap in the daemon's clock: configuration**, unchanged.
- 5 "The daemon SHALL take a note from a timer that `start()` arms and `stop()` clears, ..." → **Gap in the daemon's clock: when notes are taken**, unchanged.
- 6 "The first note of a process SHALL NOT be a gap." → **Gap in the daemon's clock: notes that are not gaps**, unchanged.
- 7 "A note earlier than the one before it SHALL NOT be a gap and SHALL become the reference for the next one." → **Gap in the daemon's clock: notes that are not gaps**, unchanged.
- 8 "A timer note that finds a gap SHALL wake the loop." → **Gap in the daemon's clock: what a note does**, unchanged.
- 9 "A note SHALL change memory only." → **Gap in the daemon's clock: what a note does**, unchanged.
- 10 "The tick SHALL write the gaps noted since the last write at its start and again where the reconcile phase reads the clock, and the lease-expiry test SHALL write them before it tests a lease." → **Gap in the daemon's clock: writing gaps**, unchanged.
- 11 "Each write SHALL be one transaction that appends one `daemon.gap` event per gap, ..." → **Gap in the daemon's clock: writing gaps**, unchanged (its "Each write" is the writes of sentence 10, which it follows there).
- 12 "Awake time SHALL leave out every noted gap, written or not." → **Gap in the daemon's clock: awake time and progress**, unchanged.
- 13 "A gap SHALL NOT be a progress signal." → **Gap in the daemon's clock: awake time and progress**, unchanged.
- 14 "A new orchestrator SHALL read the gaps of the run's earlier `daemon.gap` events when it is constructed." → **Gap in the daemon's clock: gaps read at restart**, unchanged.
- 15 "They SHALL count towards awake time and SHALL NOT start a hold." → **Gap in the daemon's clock: gaps read at restart**, unchanged (its "They" is the gaps of sentence 14, which it follows there).
- 16 "Time during which no daemon process ran SHALL NOT be a gap." → **Gap in the daemon's clock: gaps read at restart**, unchanged.
- 17 "Writing a gap SHALL be activity for idle exit: the time of the last activity becomes the gap's end, with or without a hold." → **Gap in the daemon's clock: idle exit**, unchanged.
- 18 "This excepts operator-control "Idle exit", whose list of what counts as activity does not name it." → **Gap in the daemon's clock: idle exit**, unchanged.
- 19 "`status().liveLaunches[].idleMs` and `elapsedMs` SHALL be awake time; this excepts the sentence of health-monitoring "Usage accounting" that says `elapsedMs` gives wall time." → **Gap in the daemon's clock: status times**, unchanged.
- 20 "No status field reports gaps or the hold." → **Gap in the daemon's clock: status times**, unchanged.
- 21 "`maxWaitMs`, the report grace, the claim window, push retry backoff, remote git timeouts, the check command's timer and the journal's flush deadline SHALL keep counting wall time." → **Gap in the daemon's clock: wall-time clocks**, unchanged.
- 22 "With no gap every value SHALL equal what wall time gives." → **Gap in the daemon's clock: wall-time clocks**, reference made explicit: "With no gap every value measured in awake time SHALL equal what wall time gives."

### Hold after a gap

Stays: 1 ("The hold SHALL run from the end of the latest gap ..."), 2 ("During the hold nothing SHALL start: ..."), 6 ("The `daemon.gap` event SHALL be the only trace of a hold.").

- 3 "The admission phase SHALL test the hold after the pause test, and again (noting the clock first) before each resume, each new launch and each spawn of a parked launch, so a sleep in the middle of the pass stops the rest of it." → **Hold after a gap: tests in the admission phase**, unchanged.
- 4 "A hold SHALL NOT stop claims, SHALL NOT change how a dead process or a cancelled task is handled, and SHALL NOT pause the run or count as a stall." → **Hold after a gap: what the hold does not stop**, unchanged.
- 5 "While the hold is on the daemon's idle time SHALL be 0; this excepts operator-control "Idle exit", whose idle time is otherwise the time since the last activity." → **Hold after a gap: idle time**, unchanged.

### Limits read at every check

Stays: 1 ("The stuck check and the launch time budget check SHALL read ..."), 4 ("A launch already flagged stuck SHALL stay flagged until progress clears it, also after `health.stuckAfterMs` is raised.").

- 2 "Idle and elapsed time are measured as "Stuck detection and escalation", "Launch time budget" and "Gap in the daemon's clock" state; only the limit they are compared with follows the override." → **Limits read at every check: raised and lowered limits**, unchanged.
- 3 "A raised limit SHALL keep a launch that has not yet crossed it; a lowered or cleared limit SHALL apply at once." → **Limits read at every check: raised and lowered limits**, unchanged.
- 5 "A change that lands while the tick is already ending a launch does not save it." → **Limits read at every check: raised and lowered limits**, unchanged.

## Where each new scenario comes from

At the base commit 8fd000d:

- "Price table checked at load": `test/health/budgets.test.ts` ("defaults to an empty table", "rejects a negative rate, a missing required rate, an unknown rate, and an unsafe model key").
- "Worker's posted cost is kept": `test/slice/worker-usage.test.ts` ("a reported cost: the posted cost and tokens are on the launch row, in launch.usage and in /v1/status").
- "Cached input billed at its own rate": `test/health/budgets.test.ts` ("bills input minus cached input at the input rate and cached input at its own rate, falling back to the input rate"); `src/loop/orchestrator.ts` (`priceUsage` applied when the usage is recorded).
- "Total rounded to 1e-6": `test/health/budgets.test.ts` ("rounds to 1e-6").
- "Reasoning output billed on top of output": `test/health/budgets.test.ts` ("bills reasoning output on top of output at its own rate, falling back to the output rate").
- "Tokens without a price under a budget": `test/loop/health.test.ts` ("a usage with only tokens is recorded; without a price its cost is unknown, counted as unpriced, and does not pause admission"); `src/loop/orchestrator.ts` (`unpricedModelsLogged`: one warning per model); `src/health/budgets.ts` (`unpricedLaunches`).
- "Override raises the ceiling by one budget": `test/loop/health.test.ts` ("crossing the run cost budget pauses admission; resume is refused until overridden").
- "Edits change the fingerprint without an index write": `test/slice/workspace-fingerprint.test.ts` ("still changes on a content edit and an untracked file, and ignores .orchestrator/, all without writing the index"); `src/workspace/fingerprint.ts`.
- "Rule off at zero": `test/health/gaps.test.ts` ("gapAfterMs 0 turns the rule off: nothing is ever a gap"); `test/loop/gap.test.ts` ("is not armed with health.gapAfterMs 0"); `src/config.ts` (`DEFAULT_GAP_AFTER_MS`, `DEFAULT_GAP_HOLD_MS` 60000).
- "Note timer interval": `test/health/gaps.test.ts` ("noteIntervalMs: is a second, or a quarter of gapAfterMs when shorter, and never 0").
- "A backwards note becomes the reference": `test/health/gaps.test.ts` ("a note earlier than the one before it is not a gap and becomes the new reference").
- "A sleep inside a tick is written by the next tick": `test/loop/gap.test.ts` ("a sleep inside the tick loop": "a spawned launch is not flagged, failed or ended for time in that tick; the next tick writes the gap").
- "Claimed launch renewed by the write": `test/loop/gap.test.ts` ("a claimed launch survives a sleep of five TTLs between ticks, renewed without progress, and expires a TTL later").
- "Writing a gap does not clear a stuck flag": `test/loop/gap.test.ts` ("a launch flagged stuck before the sleep stays flagged, and writing the gap appends no unstuck and no notice").
- "Loaded gaps count but do not hold": `test/health/gaps.test.ts` ("loaded gaps count towards awake time but are not pending, set no hold and are no reference for the next note").
- "The gap alone is activity": `test/loop/gap.test.ts` ("with health.gapHoldMs 0 the gap alone is activity").
- "Elapsed time leaves out a sleep": `test/loop/gap.test.ts` ("a sleep of twice the budget leaves the launch live; awake time past the budget ends it").
- "No gap, wall time": `test/loop/gap.test.ts` ("without a gap idle and elapsed time are wall time").
- "A sleep in the middle of the pass": `src/loop/tick.ts` (the admission phase returns when `o.inHold()` holds after the pause test and before each resume, each new launch and each spawn of a parked launch); `src/loop/orchestrator.ts` (`inHold()` notes the clock first).
- "A hold is neither a pause nor a stall": `test/loop/gap.test.ts` ("admits, resumes, spawns and verifies nothing inside the hold, and all four after it": `status()` matches `{ paused: false, stalled: false }` inside the hold).
- "Idle time runs from the gap's end after the hold": `test/loop/gap.test.ts` ("the hold keeps a quiescent daemon from exiting, and the gap counts as activity": `idleMs()` is 0 at `HOLD - 1` and `HOLD` once the hold ends).
- "Elapsed time counts from the launch's start, not from the override": `test/loop/health.test.ts` ("a raised time budget saves a spawned launch, which then ends at the new budget").

## Capabilities

### New Capabilities

### Modified Capabilities

- `health-monitoring`: five long requirements ("Run cost budget", "Worktree observation takes no index lock", "Gap in the daemon's clock", "Hold after a gap", "Limits read at every check") have their descriptions cut to one behavior each; the moved behaviors become 21 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-health-monitoring-2/`. Spec text only; no code changes.
