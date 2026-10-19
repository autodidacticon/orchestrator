## Why

An operator cannot select the kind by flag or tool argument with its own leaves, the start tool would default an opencode run to pull mode where no opencode worker exists until the work loop lands, and a `needsAccess` question from an auto-rejected command has no documented remedy.

## What Changes

1. CLI: `--runner-kind opencode`; `--permission <derived|allow>` and `--data-dir <shared|launch>` set `opencode.permission` and `opencode.dataDir`; `--clear opencode.permission` works like the other leaves; usage text names the three kinds and their default models; `--commit` binds to opencode as to the others.
2. MCP server: `RUNNER_ARG_TEXT` names opencode (default `anthropic/claude-opus-5-5` at medium, `commit agent`, `permission derived`, `dataDir shared`); `start` and `configure` take `opencode: { model, effort }`, `permission`, `dataDir`; `effort` text names the opencode set. Start-mode default: `spawn` when the kind in force is opencode and no mode is configured, with a message mirroring the codex one ("pull-mode workers for opencode come from `orchestrator-work --runner opencode`"); the pull-mode explanation names the kind.
3. Skills (Claude Code plugin edition): `needsAccess` from an opencode launch offers `configure` with `permission: allow` for later launches, or answering the question, mirroring the codex `sandbox` offer; the import and run skills' toolchain line names the kind.
4. `status.config` carries the opencode leaves with their sources (the resolver already does once ORC-57 lands; this issue asserts the surface).

## Capabilities

- `host-integration`: modified: "Skills report the toolchain"
- `operator-control`: modified: "Configuration route", "Status report: configuration", "Start arguments"

## Impact

* src/operator/cli.ts, src/operator/mcp-server.ts
* hosts/claude-code/skills/run/SKILL.md, hosts/claude-code/skills/import/SKILL.md
* test/slice/operator.test.ts, test/slice/operator-mcp.test.ts, test/slice/config.test.ts (the existing operator tests)

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-59 edited `openspec/specs` directly in commit 1226e60 instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-59 issue text.

Commit summary: Operators can now pick the opencode kind and set its leaves. orchestrator-ctl config takes --runner-kind opencode, --permission <derived|allow> and --data-dir <shared|launch>. --clear opencode.<leaf> works, and --commit binds to opencode the same way it does for the other kinds. The usage text names all three kinds and their default models. The MCP start and configure tools take opencode { model, effort }, permission and dataDir, and RUNNER_ARG_TEXT names the opencode defaults. When no mode is configured, start runs an opencode run in spawn mode. defaultModeFor and modeNoteFor are now exported. The modeNote names the kind; for opencode it names `orchestrator-work --runner opencode`. The run skill's needsAccess remedy now depends on the launch's kind: allowedTools for claude-code, a wider sandbox for codex, permission: allow for opencode. The run, import and work skills name opencode in the toolchain line, the labels and the file keys. The operator-control and host-integration specs are updated. Commits 0e204a4 and the follow-up on branch task/ORC-59/l1.
