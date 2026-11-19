## Why

In Claude Code a pull-mode run is worked by the session's own subagents, so the user sees `claim <worker>` and `work <worker> <task>` agents. In Codex nothing comparable is visible (ORC-142, reported 2026-11-17). Pull mode is worked by `orchestrator-work`, a shell process that runs one `codex exec` per claim outside the session, with `--ephemeral` by default, so no worker can be found later. The Codex run skill also says, as fact, that the session has no subagents. Codex 0.170.0 shows otherwise (`hosts/codex/README.md` "Workers in a Codex session"): a session, and a plugin's skill, can start subagents with `spawn_agent`, and the TUI shows them.

## What Changes

- `hosts/codex/README.md` gains "Workers in a Codex session": each fact about kept exec sessions, `codex resume`, `codex agents`, session names, subagents and the feature flags, with the command that shows it, checked with codex-cli 0.170.0 on 2026-11-18.
- The Codex `orchestrator-run` skill no longer says the session has no subagents. It says a Codex session can start subagents but no orchestrator work loop uses them yet. Its pull-mode part tells the user that `runner.codex.ephemeral: false` keeps each worker's session and how to find a launch's session: `codex resume --include-non-interactive` in the worktree (or `--all`), or `codex exec resume <thread_id>`. The default of `runner.codex.ephemeral` stays `true`.
- `orchestrator-work` prints each codex launch's thread id, from the first `thread.started` event, and whether the session is kept.
- `design.md` holds the design of an in-session Codex work loop (claim, work, report, as `hosts/claude-code/workflows/work.js` does), with its open questions. It is not built here; the tasks under "Later" are for a later task.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `host-integration`: ADDED "Codex README shows what Codex can show of workers", "Run skill says where a Codex worker's session is", and "Work loop names each codex session". "Codex host" and "Work loop by runner kind" are unchanged: nothing in their text is contradicted (the skills still have no Workflow or subagent section).

## Impact

- `hosts/codex/README.md`, `hosts/codex/skills/run/SKILL.md`, `hosts/codex/bin/work.mjs`. The OpenCode run skill, which `test/host/opencode-host.test.ts` keeps block for block equal to the Codex edition outside its pinned blocks, gets the same paragraph on codex workers' sessions (its work loop also works `codex` launches with `--runner codex`); tests `test/host/codex-host.test.ts`, `test/host/work-loop.test.ts`, `test/slice/codex-work.test.ts`.
- No change to `src/`: the Codex command (`DEFAULT_CODEX_COMMAND`, `runner.codex.ephemeral`) is unchanged, because `codex exec` has no option that names a session, so `worker-runners` "Codex runner command composition" is untouched.
- A user who sets `runner.codex.ephemeral: false` gets one Codex session per worker launch in `~/.codex/sessions` and `~/.codex/state_5.sqlite`.
