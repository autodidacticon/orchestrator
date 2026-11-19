## ADDED Requirements

### Requirement: Codex README shows what Codex can show of workers
`hosts/codex/README.md` SHALL have a section "Workers in a Codex session" that names the codex version it was checked with and gives, each with the command that shows it: whether a `codex exec` session kept without `--ephemeral` is listed by `codex resume` and where its file is, whether a session can be named or is found by its cwd, whether `codex agents` lists exec sessions, and whether a session or a plugin's skill can start subagents and the TUI shows them.

#### Scenario: The section names its facts and commands
- **WHEN** the host tests read the README from `## Workers in a Codex session` up to `## Approvals`
- **THEN** it names `codex-cli 0.170.0`, `codex resume --include-non-interactive`, `codex agents`, `thread_spawn_edges`, `spawn_agent`, `agents.enabled=false`, `multi_agent_v2`, the plugin probe `codex plugin add pingplug@probe-market`, the TUI line "Started `/root/pingworker`", and `codex exec resume <thread_id>`

### Requirement: Run skill says where a Codex worker's session is
The Codex `orchestrator-run` skill, in its pull-mode part, SHALL tell the user that `runner.codex.ephemeral: false` keeps each worker's session, listed by `codex resume --include-non-interactive` and `codex agents`, and how to find a launch's session: from its worktree, or by the thread id `orchestrator-work` prints, with `codex exec resume <thread_id>`. The default of `runner.codex.ephemeral` SHALL stay `true`. The skill SHALL NOT state that a Codex session has no subagents.

#### Scenario: The user asks where a worker went
- **WHEN** a pull-mode codex run is worked by `orchestrator-work` and the user asks why its workers are not shown in their Codex session
- **THEN** the skill says each worker is a `codex exec` outside the session, that the default `runner.codex.ephemeral: true` keeps no session, that setting it to `false` in `orchestrator.yaml` before `start` keeps one, and that a launch's session is found with `codex resume --include-non-interactive` in its worktree (or `--all`) or with `codex exec resume <thread_id>`

#### Scenario: Subagents are not denied
- **WHEN** the host tests read the Codex run skill
- **THEN** it does not say that the session has no subagents, and says that a Codex session can start subagents but no orchestrator work loop uses them yet, naming the README section

### Requirement: Work loop names each codex session
For a codex launch, `orchestrator-work` SHALL print one stderr line per launch, once the agent's output holds its first `thread.started` event, naming that event's `thread_id` and whether the session is kept: `kept: codex exec resume <thread_id>` when the claim's `codex.settings.ephemeral` is `false`, else `ephemeral: not kept`. An opencode launch SHALL print no such line.

#### Scenario: Three launches name their sessions
- **WHEN** two codex loops drain a three-task pull-mode graph with the default settings
- **THEN** their stderr holds three lines `cx-<n>: T<k> codex session <thread_id> (ephemeral: not kept)`, one per launch

#### Scenario: A kept session names the resume command
- **WHEN** the codex adapter reads output whose first event is `{"type":"thread.started","thread_id":"<id>"}` and the claim's settings have `ephemeral: false`
- **THEN** the line is `codex session <id> (kept: codex exec resume <id>)`
