## Why

The Claude Code `run` and `work` skills start the bundled workflow with `Workflow({ scriptPath: "<plugin dir>/workflows/work.js", ... })`. Claude Code's Workflow tool loads a `scriptPath` only from the working directory, a directory added with `/add-dir` or `--add-dir`, or a path it returned earlier in the session. The plugin lives under `~/.claude/plugins/cache/...`, so the call is refused in every session that has not added that directory (seen 2026-11-17 when starting the CLOUD-M3 run; ORC-140).

## What Changes

- The `run` and `work` skills tell the session to read `workflows/work.js` from the plugin directory and pass its whole text as the Workflow tool's `script` input, with the same `args`.
- `scriptPath` with the plugin path is named only as an alternative when the plugin directory has been added with `/add-dir`; after one inline run the tool returns a saved script path, which a re-run with the same run tag may use.
- `workflows/work.js` is unchanged. The Codex and OpenCode hosts use the `orchestrator-work` bin and are unchanged.

## Impact

- `hosts/claude-code/skills/run/SKILL.md`, `hosts/claude-code/skills/work/SKILL.md`
- `test/host/work-loop.test.ts` pins the inline instruction and checks that the shipped plugin directory holds `workflows/work.js`.
- Spec `host-integration`: requirement "Work skill and workflow".
