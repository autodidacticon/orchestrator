## Why

The OPENCODE-M3 review (ORC-72) found two spec sentences the code does not match. host-integration "OpenCode host" and `hosts/opencode/README.md` say worker launches pass `--pure` and never load the session plugin, but `--pure` comes from the `{pure}` slot, filled only when `runner.opencode.pure` is true (the default). With `pure: false` a globally installed plugin loads into worker launches and can append its start line to the worker's brief message. operator-control "Start arguments" says a codex or opencode run started in spawn gets a `modeNote` naming `orchestrator-work --runner <kind>`, but `modeNoteFor` named bare `orchestrator-work` for codex, and no test checked the codex note's text.

## What Changes

- host-integration "OpenCode host": worker launches pass `--pure` by default through `runner.opencode.pure`, and with `pure: false` they load installed plugins, this one included. The README says the same.
- `modeNoteFor` names `orchestrator-work --runner codex` for a codex run, like opencode's note. Codex is the loop's default runner, so the command does the same thing, but the note now matches the spec and names the kind for every kind.
- operator-control "Start arguments": the pull-mode note names the same work loop, which carries `--runner <kind>` for codex too. A new scenario covers the codex note.

## Capabilities

### New Capabilities

### Modified Capabilities

- `host-integration`: the OpenCode host requirement says `--pure` is a setting for worker launches.
- `operator-control`: the Start arguments requirement says the codex `modeNote` names `--runner codex`.

## Impact

- `src/operator/mcp-server.ts`, `test/slice/operator-mcp.test.ts`, `hosts/opencode/README.md`.
