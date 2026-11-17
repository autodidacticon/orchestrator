## Why

`runner.codex.networkAccess` can be set only in `orchestrator.yaml`, although "Runner kind configuration" says every operator surface exposes the per-kind keys. An operator who needs a Codex worker's commands to reach a package registry has to edit the file and restart the run (ORC-129, task 84b).

## What Changes

- The override document gains the leaf `codex.networkAccess`: `true` or `false` set it, and only null clears it, so the value falls back to the file, else to unset. `false` wins over a file that sets `true`. Any other value, the strings `"true"` and `"false"` included, is refused with 400 naming `codex.networkAccess`.
- The leaf is set through `PUT /v1/config` (`{ codex: { networkAccess } }`), the `start` and `configure` tools (a flat boolean argument `networkAccess`, nullable on `configure`, folded under `codex` as `sandbox` is), `--set codex.networkAccess=true|false` on the daemon and `orchestrator-ctl start`, and `orchestrator-ctl config --set` and `--clear codex.networkAccess`. `--set` reads exactly `true` or `false`; anything else is a usage error that names the key. There is no `--network-access` flag.
- The effective configuration carries the override (`runner.codex.networkAccess`), so the Codex runner and the claim read it, and the report shows `config.codex.networkAccess` with source `argument`, `file` or `default`. `applied` names `codex`.
- The value applies to launches spawned or claimed after the change. It is accepted and reported under every sandbox, with a `codex.command` that has no `{codexOverrides}` slot, and under a run kind that is not `codex`, with no warning.
- The `configure` paragraph of each run skill names `networkAccess`, says it widens what a Codex worker can reach, and says it is set only when the user says so.
- An opt-in test, `test/e2e/codex-network.test.ts` (`ORCH_E2E_CODEX_NETWORK=1`), probes a real Codex with and without the flag. The owner runs it.

## Capabilities

### New Capabilities

### Modified Capabilities
- `worker-runners`: ADDED "Codex network access override".
- `host-integration`: ADDED "Run skill names the Codex network access override".

## Impact

- `src/runs/resolve.ts`, `src/operator/mcp-server.ts`, usage texts in `src/main.ts` and `src/operator/cli.ts`, the three run skills, tests.
- No change to `src/config.ts`, `src/runner/codex.ts`, the routes, the lifecycle or the loop: the file key and the flag exist, and the claim already carries the effective settings.
- A downgrade to 0.5.1 with the leaf stored reads the whole override document as empty; the upgrade notes say to clear the leaf first.
