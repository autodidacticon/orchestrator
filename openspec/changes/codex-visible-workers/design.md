## Context

`hosts/codex/README.md` "Workers in a Codex session" shows, with codex-cli 0.170.0:

- A `codex exec` session kept without `--ephemeral` is listed by `codex resume --include-non-interactive` and by `codex agents` (grouped by project cwd, Inactive), not by plain `codex resume`. It has no name; it is found by its cwd or its thread id (`codex exec resume <thread_id>`).
- A session can start subagents with `spawn_agent` (parameters `task_name`, `message`, `model`, `reasoning_effort`, `fork_turns`), wait with `wait_agent` (10 s to 1 h), and talk to them with `send_message` and `followup_task`. A plugin's skill can ask for one. The interactive TUI shows "Started `/root/<task_name>`", "Waiting for agents" and "Completed ..." lines and an "← agents" view. `-c agents.enabled=false` removes the tools; the `multi_agent` flags do not.
- A child is its own thread (`threads.source` `{subagent: ...}`, linked in `thread_spawn_edges`) but not a row of its own in `codex agents` or the resume pickers, and the spawn is not in the exec `--json` stream.

So the Claude Code pattern, a session that fans out workers the user can watch, is possible in Codex. This change only records the facts and fixes the skill; the in-session loop is designed here for a later task.

## Goals / Non-Goals

**Goals (later task):** an in-session Codex work loop: the session starts N worker subagents, each of which claims a `codex` launch, works it in the claimed worktree and reports, until nothing is claimable, as `hosts/claude-code/workflows/work.js` does for Claude Code.

**Non-Goals:** replacing `orchestrator-work`, which stays the path for a shell and for `codex exec` sessions; changing the daemon's claim, lease or report API; making children rows of their own in `codex agents`, which Codex decides.

## Decisions

1. **A `work` section in the Codex run skill, not a new executable.** Codex has no Workflow runtime, so the loop is skill text: the session (the coordinator) calls `status`, then `spawn_agent` once per worker with `task_name` `work_<tag>_<n>`, `fork_turns: "none"`, and a self-contained message (the worker rules below). It then loops on `wait_agent` and `status`, relaying questions and reviews as the run skill already does. Alternative: the coordinator claims and hands each claim to a fresh child. Rejected for a first version, because it serialises claims through the coordinator's turn; kept as the fallback if children cannot call the operator tools (open question 1).
2. **Each worker child loops claim, work, report.** It calls the operator tool `claim` with `workerId <tag>-<n>` and `runner: "codex"`, reads the brief at the claimed `briefPath`, works in the claimed worktree, keeps the lease with `launch_heartbeat`, and ends with `launch_report` (or `launch_block`), exactly as the preamble of `orchestrator-work` (`workerPreamble`) says today. It claims again until `claim` answers that nothing is claimable and the stop rule of "Work loop by runner kind" holds, then gives its final answer: the launches it worked and their outcomes.
3. **Model and effort per launch.** `spawn_agent` takes `model` and `reasoning_effort` only at spawn, so one child cannot change model between launches. Long-lived workers (decision 2) are used only when every parked codex launch of the run has the same model and effort (`status.profiles`); otherwise the coordinator claims each launch itself and spawns one child per claimed launch with the claim's `model` and `effort`.
4. **Visibility.** Children are named `work_<tag>_<n>` (or `work_<task>` under decision 3), so the TUI's "Started `/root/work_cx_1`" lines and agents view say which worker holds which launch, and `status.workers` shows `<tag>-<n>` as for the shell loop.

## Risks / Trade-offs

- [The session's context grows with every relay] → the coordinator's message to each child is self-contained (`fork_turns: "none"`), and the coordinator keeps only digests, as the run skill does.
- [A child's sandbox is the session's] → a worktree under `~/.orchestrator/runs/...` is outside a `workspace-write` session's writable roots. See open question 2.
- [Children are not separate sessions in `codex agents`] → the coordinator's progress line names each child's launch and task.

## Open Questions

These were not shown by the probes and must be answered with codex before the loop is built:

1. Can a subagent call the orchestrator operator MCP tools (`claim`, `launch_*`)? The `spawn_agent` description says a child has "the same tools as you"; untested with an MCP server and its approvals (`approval_policy = "never"` and per-tool `approve` under `codex exec`).
2. Can a child write in a worktree outside the session's cwd? `spawn_agent` takes no cwd, and `subagent_thread_environments` is under development and off. Candidates: start the session with `--add-dir <run directory>/worktrees`, or `danger-full-access`.
3. Does a child's turn survive the coordinator's turn ending in an interactive session, and how long can `wait_agent` (max 3600000 ms) be repeated while the user is idle?
4. Does the daemon see the child's process as the session's for attachments (the SessionEnd rule of ORC-143), given that children run in the same codex process?
5. Usage: `codex exec` reports usage per `turn.completed`; a child's tokens are not in the parent's `--json` stream. Where the loop reads each launch's usage from (the child's rollout, or `launch_report`) is undecided.
