## Why

After `confirm-worker-profile` the daemon can hold a task whose model or effort comes from a built-in default, but only when `orchestrator.yaml` sets `runner.confirmProfile`, and no tool or skill says so. A run started from a host's tools still launches its first task with whatever the built-in values are, without the user having chosen them (ORC-128, task 83b).

## What Changes

- The daemon takes `--default-confirm-profile on|off`. Any other value ends the start with `--default-confirm-profile must be on or off, not <value>` before the store is opened. After the store is open: when the file states `runner.confirmProfile`, the stored choice (kv `runner.confirmProfile`) is written to match it at every start; else, when the flag is given and the store has no choice, the flag's value is written; else nothing is written.
- `startDaemon` takes `defaultConfirmProfile` and passes the flag only to a daemon it spawns. `StartResult.confirmProfile` is the hold in force, read from the status probe in every start path, also on a running daemon when a `mode` is passed.
- The operator server passes `defaultConfirmProfile: true` at its two local spawn sites: the `start` tool and the local revival in `url()`. The remote path and `orchestrator-ctl` never pass it. The stored choice belongs to the run, so a later `orchestrator-ctl start` holds too.
- The `start` and `configure` tools gain a `claude` object (`model`, `effort`), shaped like their `codex` object, so a held `claude-code` task on a run of another kind can be released through the tools.
- The `start`, `status` and `wait` descriptions name `runner.confirmProfile`, `confirmProfile`, `profiles` and `profileHeld`.
- Each run skill gains a **Worker profile.** paragraph and a `profileHeld` monitor bullet; each import skill gains a **Worker profile.** bullet in section 1 and a **Held tasks.** paragraph in section 5; the Claude Code work skill gains a **Worker profile.** bullet. The session asks the user and never chooses from its own model.
- No event is added, no built-in model or effort changes, and there is no runtime switch for the hold: `runner.confirmProfile: false` in `orchestrator.yaml` turns it off.

## Capabilities

### New Capabilities

### Modified Capabilities
- `operator-control`: ADDED "Profile hold default for a spawned daemon".
- `operator-mcp`: ADDED "Start tool turns the profile hold on" and "Configure and start tools: claude object".
- `host-integration`: ADDED "Run skill asks for a held profile" and "Import skill reports held tasks".
