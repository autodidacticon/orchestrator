## MODIFIED Requirements

### Requirement: Skills
The Claude Code plugin SHALL provide four skills. `import` SHALL require a tracker connector: a Linear or Atlassian MCP server, or GitHub through a `gh` CLI whose `gh auth status` succeeds or a GitHub MCP server; it SHALL refuse with a clear message naming the three options otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria. `run` SHALL call `start`. When the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, `run` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag. It SHALL then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report. It SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative. The `run`, `work`, and `import` skills SHALL state that codex launches are worked only in `spawn` or `mixed` mode, because pull-mode workers are the session's Claude subagents. `run` SHALL NOT start the workflow for a run whose runner kind is `codex` unless its graph has `claude-code` tasks or `claimableByKind["claude-code"]` is above zero. `review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note. `work` SHALL remain the explicit way to add workers from a session or to switch the mode. The Codex host's edition of `import`, `run`, and `review` SHALL follow these rules with the differences stated under "Codex host", and has no `work` skill. Codex SHALL find that edition where it discovers skills: each skill linked or copied as `~/.codex/skills/<name>` (under `CODEX_HOME`), or as `.agents/skills/<name>` in a target repository that vendors them. `hosts/codex/README.md` SHALL document both, and SHALL say that a `[[skills.config]]` entry with a `path` only selects a skill Codex has already discovered (for example to disable it) and does not load one. No skill SHALL instruct the user to put the package on PATH. Skills SHALL keep digests, not raw events, in the conversation.

#### Scenario: Import without a tracker
- **WHEN** the import skill is invoked in a session with no Linear or Atlassian MCP tools, no GitHub MCP tools, and `gh auth status` failing
- **THEN** it stops with a message naming the three connectors and does not call `import_issues`

#### Scenario: Import with gh only
- **WHEN** the import skill is invoked in a session with no tracker MCP tools and `gh auth status` succeeding
- **THEN** it proceeds with the GitHub path through `gh`

#### Scenario: Run loop answers a question
- **WHEN** `wait` returns an open question during the run skill
- **THEN** the skill presents it to the user and sends the user's reply through `answer` before waiting again

#### Scenario: Run skill works the run with session subagents
- **WHEN** the run skill starts a fresh run and `start` reports mode `pull`
- **THEN** the skill runs the workflow with at most `capacity` workers before its first `wait`, and every task is executed by a session subagent

#### Scenario: Run skill in spawn mode
- **WHEN** `start` reports mode `spawn`
- **THEN** the skill runs no workflow and monitors the daemon's agents as before

#### Scenario: Codex-default run is not worked by session subagents
- **WHEN** the run skill starts a run whose `config.runnerKind` is `codex` and whose graph has no `claude-code` tasks
- **THEN** `start` reports mode `spawn` with a `modeNote`, the skill tells the user that the daemon runs the Codex agents, and it runs no workflow

#### Scenario: Codex host run skill starts in spawn
- **WHEN** the `orchestrator-run` skill starts a fresh run of the default runner kind in a Codex session, in a repository whose `orchestrator.yaml` sets no `runner.mode`
- **THEN** it calls `start` with `mode: "spawn"`, runs no workflow, and monitors the daemon's agents

#### Scenario: Codex host leaves a worked pull run alone
- **WHEN** the `orchestrator-run` skill opens a run whose daemon is running in `pull` while a Claude Code session holds launches of it
- **THEN** it calls `start` without `mode`, and the mode stays `pull`

#### Scenario: Codex skills
- **WHEN** `hosts/codex/skills/run` is linked as `~/.codex/skills/orchestrator-run`, or as `.agents/skills/orchestrator-run` in the repository a Codex session works in
- **THEN** the session's skill list names `orchestrator-run`, and a `[[skills.config]]` entry whose `path` is `hosts/codex/skills/run/SKILL.md` adds nothing by itself

### Requirement: Session start hook
Each host SHALL declare a `SessionStart` hook for `startup`, `resume`, and `clear` that runs its own copy of `hooks/session-start.mjs` with `node` and a ten-second timeout. The Claude Code plugin declares it in `hooks/hooks.json`. The Codex host declares it as `[[hooks.SessionStart]]` in `hosts/codex/config.toml`, which SHALL also set `features.hooks = true` and say that Codex runs a hook only once it is trusted. The hosts' copies of the script SHALL be identical. The script SHALL read every run directory under `ORCH_HOME` (default `~/.orchestrator`), SHALL probe an alive daemon with `GET /v1/status?probe=1` and a one-second timeout, SHALL print one line naming each run whose daemon is alive (with its running, waiting, parked, attached, awaiting-review, and open-question counts) or whose daemon is dead with an exit record showing parked launches, open questions, a milestone awaiting review, or a stall (with the exit reason and age) or with no exit record (as not stopped cleanly), ending with how to continue, and SHALL print nothing when no run qualifies. It SHALL load no package code, SHALL need nothing on PATH but `node`, and SHALL exit 0 whatever happens.

#### Scenario: Alive daemon reported
- **WHEN** a session starts while a daemon for `/Users/r/app` is alive with T2 running and MVP awaiting review
- **THEN** the hook's stdout is one line naming `/Users/r/app`, the alive daemon, T2 running, and MVP awaiting review

#### Scenario: Idle-exited run with parked work reported
- **WHEN** a run's daemon exited idle with two launches parked
- **THEN** the line names the run, `idle`, the age of the exit, and the two parked launches

#### Scenario: Finished run stays silent
- **WHEN** every run under `ORCH_HOME` finished and its daemon exited idle
- **THEN** the hook prints nothing

#### Scenario: Not stopped cleanly
- **WHEN** a run's `daemon.pid` is dead and its `daemon.json` has no exit record
- **THEN** the line names the run as not stopped cleanly

#### Scenario: Codex session start
- **WHEN** a Codex session starts with the template's hooks in its config, trusted, while a run's daemon exited idle with two launches parked
- **THEN** Codex runs `hosts/codex/hooks/session-start.mjs`, and its line naming the run and the parked launches is in the session's context

### Requirement: Session end hook
Each host SHALL declare a `SessionEnd` hook for every reason that runs its own copy of `hooks/session-end.mjs` with `node`. The Claude Code plugin declares it in `hooks/hooks.json`, and the Codex host declares it as `[[hooks.SessionEnd]]` in `hosts/codex/config.toml`. The hosts' copies of the script SHALL be identical. The script SHALL read the hook input for `reason`, and SHALL use `sessionEnded` when the input has none or is not JSON. It SHALL collect its own ancestor process ids up to six levels within 300 ms, SHALL post `{ pids, reason }` to `POST /v1/attachments/ended` of every alive daemon under `ORCH_HOME` in parallel with 400 ms timeouts, SHALL NOT wait for any release, and SHALL exit 0 within the SessionEnd budget whatever happens. It SHALL load no package code. The hook is not needed to release a session's launches. The operator server ends its own attachment when its stdio closes, and the daemon ends attachments whose first pid is dead (operator-control "Session attachments"). What the hook adds is the host's reason.

#### Scenario: Session end releases its workers' launches
- **WHEN** a session whose MCP server holds an attachment with a claimed launch ends with reason `prompt_input_exit`
- **THEN** the daemon records the attachment as ended and the next reconcile releases the launch with `keep`

#### Scenario: Hook under the budget
- **WHEN** the hook runs with three alive daemons under `ORCH_HOME`
- **THEN** it exits 0 in under one second

#### Scenario: No daemon alive
- **WHEN** the hook runs with stdin `{ "reason": "x" }` and no run under `ORCH_HOME` has an alive daemon
- **THEN** it posts nothing and exits 0 within one second

#### Scenario: Codex session end
- **WHEN** a Codex session ends whose operator server holds an attachment with a claimed launch, with the template's hooks in its config and trusted
- **THEN** Codex runs `hosts/codex/hooks/session-end.mjs` as a child of the codex process, which is also the operator server's ancestor, with input `reason` `"other"`; the daemon records the attachment as ended with reason `other`, and the next reconcile releases the launch with `keep`
