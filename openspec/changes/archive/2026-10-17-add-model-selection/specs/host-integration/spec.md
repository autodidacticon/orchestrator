## MODIFIED Requirements

### Requirement: Work skill and workflow
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable. The workflow SHALL fan out one loop per worker with `parallel`; each cycle SHALL claim with the loop's worker id, wait briefly and retry when nothing is claimable, and otherwise run a worker agent with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. A loop SHALL end when nothing is claimable, no loop holds a launch, and the digest reports finished, stalled, or an open question. Workflow results SHALL be short outcomes, never briefs or logs.

#### Scenario: Two workers drain a graph
- **WHEN** the work skill runs with two workers on a three-task graph in `pull` mode
- **THEN** every task is claimed, worked, and submitted by a worker, the integration branch gains one trailer commit per task, and the workflow returns when the run is finished

#### Scenario: Question ends the loop and a re-run resumes it
- **WHEN** a worker asks a question nobody answers and nothing else is claimable
- **THEN** the workflow returns with the question in the digest, the skill answers it through the user, and the re-run worker with the same id receives the answer through `launch_block`

#### Scenario: Worker agent runs with the claimed selection
- **WHEN** a loop claims a launch whose response carries `model: "claude-sonnet-5-5"` and `effort: "low"`
- **THEN** the worker agent for that launch is started with model `claude-sonnet-5-5` and effort `low`

### Requirement: Skills report the toolchain
After `start` returns, the `run`, `import`, and `work` skills SHALL report the resolved toolchain to the user in one line naming the check command, the integration branch, the worker model and effort, the source of each, and, for a run whose daemon spawns agents, the toolchains whose commands agents may run (for example "detected: npm test on main; workers claude-opus-5-5 at medium (default); agents may run npm and node"). When `needsConfig` names `checkCommand`, in the `start` result or in a later `wait` digest, the skill SHALL look for the test command in `CLAUDE.md`, the README, and the manifests in the repository root; when one is stated unambiguously it SHALL set it through `configure` and report the command and where it found it; otherwise it SHALL propose its best reading, or say it found none, and SHALL set what the user confirms. It SHALL NOT leave `checkCommand` unresolved while a task is `submitted` without having asked the user. In the `run` skill, when an agent asks a `needsAccess` question naming a command, the skill SHALL offer to add a rule through `configure` for subsequent launches, SHALL say that the live agent cannot gain the rule, and SHALL offer to run the command on the agent's behalf and answer with the result. The `import` skill SHALL document the `model:<name>` and `effort:<level>` labels as the way an issue chooses its worker model and effort, and SHALL report any `ignoredLabels` from the import summary to the user. When launches are worked by session subagents the allow-list part of the report SHALL be omitted; when the runner command does not apply `model` or `effort` the model part SHALL be omitted.

#### Scenario: Detected toolchain reported
- **WHEN** the run skill calls `start` in a Node repository and the result shows `checkCommand` detected as `npm test` on `main` with the default model and effort
- **THEN** the skill tells the user "detected: npm test on main; workers claude-opus-5-5 at medium" with the sources before looping on `wait`

#### Scenario: Unresolved command found in CLAUDE.md
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and `CLAUDE.md` says "run tests with `make check`"
- **THEN** the skill calls `configure` with `checkCommand: "make check"` and reports that it took the command from `CLAUDE.md`

#### Scenario: Unresolved command with nothing documented
- **WHEN** `start` returns `needsConfig: ["checkCommand"]` and neither `CLAUDE.md`, the README, nor a manifest names a test command
- **THEN** the skill asks the user for the command and calls `configure` only with what the user gives

#### Scenario: Access question answered without a restart
- **WHEN** `wait` returns a `needsAccess` question from T2 asking to run `docker compose up`
- **THEN** the skill offers to add `Bash(docker:*)` for later launches, says T2's live agent cannot gain it, and offers to run the command and answer T2 with the result

#### Scenario: Ignored label reported at import
- **WHEN** the import summary lists `ignoredLabels: [{ id: "KNO-7", label: "effort:huge" }]`
- **THEN** the import skill tells the user that KNO-7's `effort:huge` label was not recognised and the task will use the run default
