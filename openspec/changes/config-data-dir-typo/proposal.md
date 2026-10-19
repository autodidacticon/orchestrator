## Why

`--data-dir` is overloaded on `orchestrator-ctl config`: `shared` or `launch` sets `opencode.dataDir`, and any other value names the store location. When `--url` or `ORCH_URL` addresses the daemon the store location is unused, so a typo such as `--data-dir lanch` silently became a plain `GET /v1/config` that exited 0, and the operator believed `opencode.dataDir` was set (OPENCODE-M3 review, ORC-70).

## What Changes

- `orchestrator-ctl config` refuses `--data-dir` with a value other than `shared` or `launch` when `--url` or `ORCH_URL` is set, before sending anything, with a message naming both meanings and the two accepted values.
- Without a daemon URL, any other value keeps naming the store location. A distinct flag name for the leaf is left to a later change.
- The CLI usage says that such a value is refused with a daemon URL.

## Capabilities

### New Capabilities

### Modified Capabilities

- `operator-control`: the Configuration route requirement refuses a mistyped `--data-dir` leaf when the daemon is addressed by URL.

## Impact

- `src/operator/cli.ts`, `test/slice/operator.test.ts`.
