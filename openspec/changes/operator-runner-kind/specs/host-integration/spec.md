## MODIFIED Requirements

### Requirement: Skills report the toolchain
After `start` returns, the `run`, `import`, and `work` skills SHALL report the resolved toolchain to the user in one line. The line SHALL name the check command, the integration branch, the worker kind with its model and effort (`config.runnerKind`, `config.model`, `config.effort`), and the source of each. The default named SHALL be the one of the kind in force: `claude-opus-5-5` at `medium` for `claude-code`, `gpt-6-astra` at `medium` for `codex`. For a `claude-code` run whose daemon spawns agents, the line SHALL also name the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node"). For a `codex` run the line SHALL name the kind, the sandbox, and the commit policy, and SHALL have no allow-list part (for example "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits"). When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the skill SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously it SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms. It SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user. In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer to add a rule through `configure` for subsequent launches, SHALL say that the live agent cannot gain the rule, and SHALL offer to run the command on the agent's behalf and answer with the result. The `import` skill SHALL document the `runner:<kind>`, `model:<name>`, and `effort:<level>` labels as the way an issue chooses its worker kind, model, and effort, and SHALL report any `ignoredLabels` from the import summary to the user. The `run` skill SHALL document `runner.kind`, `runner.codex.*`, and `budgets.prices`. When launches are worked by session subagents the allow-list part of the report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted.

#### Scenario: Detected toolchain reported
- **WHEN** the run skill calls `start` in a Node repository and the result shows `checkCommand` detected as `npm test` on `main` with the default runner kind, model, and effort
- **THEN** the skill tells the user "detected: npm test on main; workers claude-opus-5-5 at medium" with the sources before looping on `wait`

#### Scenario: Codex toolchain reported
- **WHEN** the run skill calls `start` in a Node repository whose `orchestrator.yaml` sets `runner.kind: codex`, and the result shows `checkCommand` detected as `npm test` on `main` with the Codex default model and effort
- **THEN** the skill tells the user "detected: npm test on main; workers codex gpt-6-astra at medium (file); sandbox workspace-write, daemon commits", with no allow-list part

#### Scenario: Unresolved command found in CLAUDE.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and `CLAUDE.md` says "run tests with `make check`"
- **THEN** the skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `CLAUDE.md`

#### Scenario: Unresolved command with nothing documented
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and neither `CLAUDE.md`, the README, nor a manifest names a test command
- **THEN** the skill asks the user for the command and calls `configure` only with what the user gives

#### Scenario: Access question answered without a restart
- **WHEN** `wait` returns a `needsAccess` question from T2 asking to run `docker compose up`
- **THEN** the skill offers to add `Bash(docker:*)` for later launches, says T2's live agent cannot gain it, and offers to run the command and answer T2 with the result

### Requirement: Skills
The plugin SHALL provide four skills. `import` SHALL require a tracker connector: a Linear or Atlassian MCP server, or GitHub through a `gh` CLI whose `gh auth status` succeeds or a GitHub MCP server; it SHALL refuse with a clear message naming the three options otherwise, SHALL have the session fetch the root, its children, their blocking relations, and the state of every referenced issue, SHALL build normalized records, SHALL call `import_issues`, and SHALL report the summary including tasks missing criteria. `run` SHALL call `start`. When the mode in force is `pull` or `mixed` and the run can hold `claude-code` launches, `run` SHALL run the bundled `workflows/work.js` with a worker count no larger than the run's capacity and a run tag. It SHALL then loop on `wait`, surfacing each open question to the user and answering through `answer`, invoking the review skill when a milestone awaits review, re-running the workflow with the same run tag when it has ended while launches are still claimable, and stopping on finished or stalled with a report. It SHALL tell the user who is executing the work and SHALL offer `mode: spawn` as the explicit alternative. The `run`, `work`, and `import` skills SHALL state that codex launches are worked only in `spawn` or `mixed` mode, because pull-mode workers are the session's Claude subagents. `run` SHALL NOT start the workflow for a run whose runner kind is `codex` unless its graph has `claude-code` tasks or `claimableByKind["claude-code"]` is above zero. `review` SHALL call `review`, examine the diff and the closure reports against the acceptance criteria, and call `accept` or `reject` with a note. `work` SHALL remain the explicit way to add workers from a session or to switch the mode. No skill SHALL instruct the user to put the package on PATH. Skills SHALL keep digests, not raw events, in the conversation.

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

### Requirement: Work skill and workflow
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable. The skill SHALL say that pull-mode workers are this session's Claude subagents, which claim only `claude-code` launches, so that codex launches are worked only in `spawn` or `mixed`; when only codex launches are parked it SHALL offer `start` with `mode: "spawn"` or `"mixed"` instead of running the workflow. The workflow SHALL claim with `runner: "claude-code"`, so that codex-kind launches are never claimed by the Claude worker loop, and its stop rule SHALL count only `claimableByKind["claude-code"]`. The workflow SHALL clamp the worker count to the `capacity` argument when one is given, logging the clamp, and SHALL fan out one loop per worker with `parallel`. Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, read `status`, evaluate the stop rule, and claim again, up to three polls before returning without a launch. On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. A loop SHALL end when nothing is claimable, no loop holds a launch, and the digest reports finished, stalled, or an open question. Workflow results SHALL be short outcomes, never briefs or logs. The `work` and `run` skills SHALL document `claimModel` and `claimEffort` with their defaults and pass them only when the user asks for a different claimer, and SHALL say that workers edit worktrees under the run directory, outside the repository, so a session in `acceptEdits` mode prompts for each file there unless started with `--add-dir` for that directory.

#### Scenario: Two workers drain a graph
- **WHEN** the work skill runs with two workers on a three-task graph in `pull` mode
- **THEN** every task is claimed, worked, and submitted by a worker, the integration branch gains one trailer commit per task, and the workflow returns when the run is finished

#### Scenario: Question ends the loop and a re-run resumes it
- **WHEN** a worker asks a question nobody answers and nothing else is claimable
- **THEN** the workflow returns with the question in the digest, the skill answers it through the user, and the re-run worker with the same id receives the answer through `launch_block`

#### Scenario: Worker agent runs with the claimed selection
- **WHEN** a loop claims a launch whose response carries `model: "claude-sonnet-5-5"` and `effort: "low"`
- **THEN** the worker agent for that launch is started with model `claude-sonnet-5-5` and effort `low`

#### Scenario: Claimer runs cheap by default
- **WHEN** the workflow runs without `claimModel` or `claimEffort`
- **THEN** every claimer agent is started with model `claude-haiku-5-5` and effort `low`, and a run with `claimModel: "claude-sonnet-5-5"` starts them with that model instead

#### Scenario: Idle loop polls inside one claimer
- **WHEN** nothing is claimable and the stop rule does not hold
- **THEN** one claimer agent waits, reads status, and claims again up to three times before returning, and a launch parked during a wait is claimed on the next poll of the same agent

#### Scenario: Labels share the worker id
- **WHEN** worker `work-1-2` claims KNO-10
- **THEN** the view shows an agent labelled `claim work-1-2` followed by one labelled `work work-1-2 KNO-10`

#### Scenario: Worktrees outside the repository need an allowed directory
- **WHEN** a headless session in `acceptEdits` mode runs the workflow with `--add-dir` naming `ORCH_HOME`
- **THEN** its workers edit and commit in the worktrees without a permission prompt, and without that flag the first edit is refused

#### Scenario: Workers clamped to capacity
- **WHEN** the workflow is run with `workers: 6` and `capacity: 2`
- **THEN** two loops run and the log says the count was clamped

#### Scenario: Codex launches are not claimed by the Claude worker loop
- **WHEN** a mixed-mode run holds a parked `codex` launch and a parked `claude-code` launch and the workflow runs
- **THEN** a worker claims the `claude-code` launch only, the `codex` launch stays parked until the claim window passes and the daemon spawns it, and the loop's stop rule counts only `claimableByKind["claude-code"]`
