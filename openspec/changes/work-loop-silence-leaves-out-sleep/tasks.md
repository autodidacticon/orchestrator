## 1. Silence clock

- [x] 1.1 Export `silenceClock`, `noteEveryMs` and `DEFAULT_GAP_AFTER_MS` beside `watchVerdict` (`hosts/codex/bin/work.mjs`)
- [x] 1.2 Pure tests: awake notes end the agent, a sleep of twice the limit is left out and a further limit ends it, threshold step and backward note are not gaps, silence bounds, threshold 0 (`test/host/work-loop.test.ts`)

## 2. Flag

- [x] 2.1 `--gap-after-ms` in `parseWorkArgs` (default 60000, 0 off) and in the usage text

## 3. Watcher

- [x] 3.1 Replace `lastOutputAt` in `runWork` with the clock; note by an unref'd per-agent timer cleared on close and before each verdict; log a left-out gap

## 4. Spec

- [x] 4.1 ADDED requirement "Work loop silence leaves out a sleep" in host-integration
