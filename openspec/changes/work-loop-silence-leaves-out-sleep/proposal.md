## Why

The work loop of the Codex and OpenCode hosts (`hosts/codex/bin/work.mjs`, `orchestrator-work`) measures an agent's silence against the wall clock. After its machine sleeps longer than the silence limit, the loop ends the agent and releases the launch without keep, and the daemon fails it, which spends an attempt (ORC-122, release 0.6.0 task 11).

## What Changes

- A pure, exported silence clock (`silenceClock({ now, gapAfterMs })` with `output`, `waiting`, `note`, `silence` and `lastOutputAt`) replaces the watcher's bare `lastOutputAt`. A *gap* is two consecutive notes of the loop's clock more than `gapAfterMs` apart; its length is added to the last output time, capped at the present, so the time asleep is not silence. A step exactly at the threshold, and a note earlier than the one before it, are not gaps.
- Notes are taken by a timer per running agent, every second or a quarter of the threshold when that is shorter (unref'd, cleared when the agent closes), and by the watcher immediately before each verdict. The gap is not measured between two looks of the watcher, whose HTTP calls retry for up to 60 s while the machine is awake.
- New flag `--gap-after-ms` (default 60000, the daemon's `health.gapAfterMs` default; 0 turns the rule off). The loop logs one line, with the length it left out, when it leaves a gap out (less than the gap when output arrived after the wake, before the note).
- `watchVerdict`'s inputs, the choice of the silence limit and the report grace (wall time) are unchanged. The loop reads no daemon gap record and the claim gains no field.

## Capabilities

### Modified Capabilities

- `host-integration`: ADDED requirement "Work loop silence leaves out a sleep", an exception to "Work loop ends a hung agent" and "Work loop silence limit", whose text is unchanged.

## Impact

- `hosts/codex/bin/work.mjs` (`silenceClock`, `noteEveryMs`, `DEFAULT_GAP_AFTER_MS`, `parseWorkArgs`, the watcher in `runWork`, the usage text).
- Pure tests in `test/host/work-loop.test.ts`; no real-time sleep test.
- Its effect in a run needs the daemon to leave the same sleep out of its own stuck and lease checks (task 9); otherwise the daemon ends the launch and the loop's "the daemon ended the launch" verdict stands.
