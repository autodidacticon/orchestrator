## Why

#186 made the smoke test's M5 process probe fail when a sampling round took 5 s or longer. The review of milestone 18 found that this bounds the slowest round, not the time between the daemon samples that count: round times are whole seconds, and skipped daemon samples still record rounds, so a check of about 5 s can fall between two counted samples. The check's length is also kept in two places that nothing ties together, #186's delta dropped the clause that `cleanup` removes the probe files on any exit, and `README.md` still names the old Linear project by its key (#191).

## What Changes

- `deploy/smoke.sh`: `probe_sample` appends, for a daemon sample that counts, the millisecond time taken just before its exec to the probe's `daemon-ms` file (`now_ms`: bash's `EPOCHREALTIME`, else perl). `probe_gap` gives the longest gap between two of them in a row; `probe_summary` prints it, and `probe_held` also fails with a line naming the gap when it is `M5_GAP_MS` (4000 ms, `M5_CHECK_S` less 1 s for a sample's second read) or more. A skipped sample writes no time, so it widens the gap. The slowest-round rule stays.
- `test/host/smoke.test.ts`: cases for the gap rule, for `probe_sample` writing times only for samples that count, and one that asserts the fixture's `setTimeout` wait in `deploy/overlays/kind/fixture/test.js` equals `M5_CHECK_S` × 1000.
- `README.md` names a GitHub milestone instead of a Linear project key; `deploy/README.md` describes the gap rule.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `cluster-runtime`: MODIFIED "Smoke M5 step: process probe" (the gap rule, and `cleanup` removes the probe files on any exit).

## Impact

- Files: `deploy/smoke.sh`, `deploy/README.md`, `README.md`, `test/host/smoke.test.ts`.
- No source file changes.
