## MODIFIED Requirements

### Requirement: Work workflow: claimer agent
Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and `brief: false` and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, take its fields from the `wait` digest, and claim again, up to three polls before returning without a launch. It SHALL NOT call `status`.

#### Scenario: Claimer options
- **WHEN** the workflow runs with `claimEffort: "medium"` and no `claimModel`
- **THEN** every claimer agent is started with model `claude-haiku-5-5` and effort `medium`, labelled `claim <workerId>`, and its prompt waits with `until "any"` and `timeoutMs` 90000, takes its fields from the `wait` digest, and asks for no `status` call

### Requirement: Work workflow: worker agent
On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from tool instructions plus the brief's path, `briefPath`, and SHALL tell the worker to read the whole brief file before doing anything else. The claimer SHALL NOT read the brief, and its answer SHALL have no `briefMarkdown`.

#### Scenario: Brief in the prompt
- **WHEN** a claim returns `briefPath` `/wt/.orchestrator/brief.md` for KNO-10
- **THEN** the worker agent's prompt names `/wt/.orchestrator/brief.md` after the tool instructions and says to read the whole file before anything else, and the agent is labelled `work <workerId> KNO-10`

### Requirement: Work workflow: claims only claude-code launches
The workflow SHALL claim with `runner: "claude-code"`, so that codex-kind launches are never claimed by the Claude worker loop, and its stop rule SHALL count only `claimableByKind["claude-code"]` and `preparingByKind["claude-code"]` (0 when the `wait` digest has no `preparingByKind`), which the claimer copies from the digest as `claimable` and `preparing`.

#### Scenario: Claim names the runner
- **WHEN** the claimer prompt of `workflows/work.js` is composed
- **THEN** its claim step passes `runner "claude-code"`, and it takes `claimable` from the digest's `claimableByKind["claude-code"]` and `preparing` from its `preparingByKind["claude-code"]`, 0 when the digest has no `preparingByKind`

### Requirement: Work workflow: loop end
A loop SHALL end when nothing is claimable, nothing is being prepared for `claude-code`, nothing is under verification, no other loop holds a launch, and the digest reports an open question or a milestone awaiting review that is not under verification, or at once when the digest reports finished or stalled.

#### Scenario: Held launch keeps the loops going
- **WHEN** nothing is claimable or being prepared and a question is open, while another loop holds a launch
- **THEN** `stopRule` gives false and the loop runs another claimer

### Requirement: Work skill and workflow
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. Workflow results SHALL be short outcomes, never briefs or logs.

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
- **WHEN** nothing is claimable and neither `finished` nor `stalled` is true
- **THEN** one claimer agent waits, takes its fields from the `wait` digest, and claims again up to three times before returning, and a launch parked during a wait is claimed on the next poll of the same agent

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

#### Scenario: A launch being prepared keeps the claimer polling
- **WHEN** nothing is claimable for `claude-code`, a question is open, and the digest's `preparingByKind["claude-code"]` is 1 because a launch's prepare command runs
- **THEN** the claimer returns `preparing` 1, `stopRule` gives false, and the loop runs another claimer; a digest without `preparingByKind` is read as 0

#### Scenario: Workflow started inline from the plugin
- **WHEN** a session that has not added the plugin directory runs the work or run skill in `pull` mode
- **THEN** the skill reads `<plugin dir>/workflows/work.js` and calls the Workflow tool with its text as `script` and the same `args`, and the workflow starts without a `scriptPath` refusal

## ADDED Requirements

### Requirement: Work workflow: claimer agent: digest fields
A claimer that claims nothing SHALL return, with `claimed: false`, the fields of its last `wait` digest: `finished`, `stalled`, `claimable` (`claimableByKind["claude-code"]`), `preparing` (`preparingByKind["claude-code"]`, 0 when absent), `verifying`, `openQuestions` and `awaitingReview`. It SHALL return before its third poll only when `finished` or `stalled` is true.

#### Scenario: Finished digest returns at once
- **WHEN** the first `wait` of a claimer answers a digest with `finished` true
- **THEN** the claimer returns the seven fields at once with `claimed: false`, without a second poll

#### Scenario: Open question keeps the claimer polling
- **WHEN** each `wait` answers a digest with a question open, nothing claimable and neither `finished` nor `stalled`
- **THEN** the claimer claims again until three polls are done and then returns the seven fields of the last digest

### Requirement: Work workflow: claimer agent: stop rule in the script
The script SHALL decide whether a loop stops with a function `stopRule(d, othersHold)` over the claimer's digest fields, where `othersHold` is whether another loop holds a launch. It SHALL stop when `finished` or `stalled` is true, or when nothing is claimable, being prepared or under verification, no other loop holds a launch, and a question is open or a review is awaited for an id not under verification.

#### Scenario: Stop rule table
- **WHEN** `stopRule` is given a digest with a question open, `claimable` and `preparing` 0 and `verifying` empty
- **THEN** it gives true when no other loop holds a launch, false when another does, false when `preparing` is 1, and true when `preparing` is absent

#### Scenario: Awaited review under verification
- **WHEN** `stopRule` is given a digest whose only awaited review is for an id listed in `verifying`
- **THEN** it gives false

#### Scenario: Another loop's worker returns
- **WHEN** loop 2's claimer answers a digest with a question open and nothing claimable while loop 1's worker is pending, and answers the same digest after that worker returns
- **THEN** loop 2 claims again after the first answer and ends after the second

### Requirement: Work workflow: claimer agent: a silent claimer
When a claimer returns nothing, the loop SHALL log `<workerId>: claimer returned nothing, retrying` and run one more claimer; when that one also returns nothing, the loop SHALL end, logging `<workerId>: claimer returned nothing twice, loop ends`. A claimer that answers with `error` SHALL end its loop with a log line naming the error.

#### Scenario: One silent claimer is retried
- **WHEN** the first claimer of loop `work-1` returns nothing and the second claims a launch
- **THEN** the log holds `work-1: claimer returned nothing, retrying` and the worker agent runs on the launch

#### Scenario: Two silent claimers end the loop
- **WHEN** two claimers of loop `work-1` in a row return nothing
- **THEN** the loop ends and the log holds `work-1: claimer returned nothing twice, loop ends`
