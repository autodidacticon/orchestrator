## Why

Spawned launches lost their usage in three ways (ORC-136, found in the R1 Release 0.6.0 run). The Claude parser gave up after 200 `{` characters, so a result line holding 220 of them (ORC-116, 11.21 USD) was never reached. A reap returned as soon as the launch's `/bin/sh` was gone, before the agent itself had written its result line (ORC-98, 3.84 USD, written 0.16 s after the read). And the 30 s report grace ended three launches that were still working.

## What Changes

- `parseUsage` tries every `{` that starts a line first, last first, then every `{` as before, each pass at most 200 tries. A one-line result object is found at the first try whatever it holds. Its signature and result are unchanged.
- `killTree` waits for the launch's process group to be empty, not only for the recorded pid, before the SIGKILL and after it (at most the kill grace, then 1000 ms). Usage is read after the reap, as before, so a line written while the agent is terminated is read.
- The default of `health.reportGraceMs` becomes 120000. It stays a config-file key read at start and is not a runtime override. No key is added.

## Capabilities

### Modified Capabilities

- `health-monitoring`: "Usage accounting" (the default, the order reap, wait for the group, record usage, the bound, the Claude parser; scenarios "Grace elapses" changed, three added).

## Impact

- `src/runner/claude-code.ts`, `src/runner/subprocess.ts`, `src/config.ts`.
- Every reap (cancel, cascade, stuck, time budget, stop with reap) now waits for the agent itself, up to the kill grace plus 1000 ms. The Codex and OpenCode runners inherit it.
- A reported agent may keep working, and spending, for up to two minutes instead of 30 s.
- Not changed: `src/loop/tick.ts`, `README.md`, the work loop's own grace in `hosts/codex/bin/work.mjs`.
