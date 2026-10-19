## 1. Implementation

- [x] 1.1 CLI: `--runner-kind opencode`; `--permission <derived|allow>` and `--data-dir <shared|launch>` set `opencode.permission` and `opencode.dataDir`; `--clear opencode.permission` works like the other leaves; usage text names the three kinds and their default models; `--commit` binds to opencode as to the others.
- [x] 1.2 MCP server: `RUNNER_ARG_TEXT` names opencode (default `anthropic/claude-opus-5-5` at medium, `commit agent`, `permission derived`, `dataDir shared`); `start` and `configure` take `opencode: { model, effort }`, `permission`, `dataDir`; `effort` text names the opencode set. Start-mode default: `spawn` when the kind in force is opencode and no mode is configured, with a message mirroring the codex one ("pull-mode workers for opencode come from `orchestrator-work --runner opencode`"); the pull-mode explanation names the kind.
- [x] 1.3 Skills (Claude Code plugin edition): `needsAccess` from an opencode launch offers `configure` with `permission: allow` for later launches, or answering the question, mirroring the codex `sandbox` offer; the import and run skills' toolchain line names the kind.
- [x] 1.4 `status.config` carries the opencode leaves with their sources (the resolver already does once ORC-57 lands; this issue asserts the surface).

## 2. Record

- [x] 2.1 Spec edits landed in 1226e60; change directory reconstructed at archive time
