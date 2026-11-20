## MODIFIED Requirements

### Requirement: Work skill and workflow
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. Workflow results SHALL be short outcomes, never briefs or logs.

#### Scenario: Two workers drain a graph
- **WHEN** the work skill runs with two workers on a three-task graph in `pull` mode
- **THEN** every task is claimed, worked, and submitted by a worker, the integration branch gains one trailer commit per task, and the workflow returns when the run is finished

#### Scenario: Question ends the loop and a re-run resumes it
- **WHEN** a worker's question is still unanswered when its launch ends (the wait limit passed, or the launch was handed back) and nothing else is in sight for `claude-code`
- **THEN** the claimer returns the verdict `human`, or `stalled` when nothing else in the run can proceed, the workflow returns with the question in the digest, and the skill answers it through the user; while the launch still waits, its loop claims it back, and a re-run worker with the same id receives the answer through `launch_block`

#### Scenario: Worker agent runs with the claimed selection
- **WHEN** a loop claims a launch whose response carries `model: "claude-sonnet-5-5"` and `effort: "low"`
- **THEN** the worker agent for that launch is started with model `claude-sonnet-5-5` and effort `low`

#### Scenario: Claimer runs cheap by default
- **WHEN** the workflow runs without `claimModel` or `claimEffort`
- **THEN** every claimer agent is started with model `claude-haiku-5-5` and effort `low`, and a run with `claimModel: "claude-sonnet-5-5"` starts them with that model instead

#### Scenario: Idle loop polls inside one claimer
- **WHEN** nothing is claimable and the verdict for `claude-code` is none of `finished`, `stalled` and `human`
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
- **THEN** a worker claims the `claude-code` launch only, the `codex` launch stays parked until the claim window passes and the daemon spawns it, and the loop reads only `workByKind["claude-code"]`

#### Scenario: A launch being prepared keeps the claimer polling
- **WHEN** nothing is claimable for `claude-code`, a question is open, and a launch's prepare command runs
- **THEN** the digest's verdict for `claude-code` is `standby` with `preparing` 1, and the loop runs another claimer

#### Scenario: Workflow started inline from the plugin
- **WHEN** a session that has not added the plugin directory runs the work or run skill in `pull` mode
- **THEN** the skill reads `<plugin dir>/workflows/work.js` and calls the Workflow tool with its text as `script` and the same `args`, and the workflow starts without a `scriptPath` refusal

### Requirement: Work workflow: claims only claude-code launches
The workflow SHALL claim with `runner: "claude-code"`, so that codex-kind launches are never claimed by the Claude worker loop, and its loop SHALL read only the `claude-code` entry of the `wait` digest's `workByKind`, whose `verdict`, `claimable`, `preparing` and `working` the claimer copies.

#### Scenario: Claim names the runner
- **WHEN** the claimer prompt of `workflows/work.js` is composed
- **THEN** its claim step passes `runner "claude-code"`, and it takes `verdict`, `claimable`, `preparing` and `working` from the digest's `workByKind["claude-code"]`, naming neither `claimableByKind` nor `preparingByKind`

### Requirement: Work workflow: loop end
A loop SHALL end when the claimer returns the daemon work verdict for `claude-code` as `finished`, `stalled` or `human`. On any other verdict, `paused` included, it SHALL run another claimer. The script SHALL hold no stop rule of its own and SHALL NOT track which loops hold a launch. The workflow result's `digest` SHALL be `{ verdict, finished, stalled, claimable, preparing, working, openQuestions, awaitingReview }` of the last answer, with `finished` and `stalled` derived from the verdict.

#### Scenario: Held launch keeps the loops going
- **WHEN** nothing is claimable or being prepared and a question is open, while a launch of `claude-code` is still worked
- **THEN** the digest's verdict is `standby` and the loop runs another claimer

#### Scenario: Verdicts that end a loop
- **WHEN** a loop's claimer answers `verdict: "standby"` and then `verdict: "human"`
- **THEN** the loop runs two claimers and ends; a first answer of `finished` or `stalled` ends it after one claimer, and `idle`, `paused`, `claim` or an unknown word runs another

#### Scenario: Another loop's worker is pending
- **WHEN** loop 2's claimer answers `verdict: "standby"` while loop 1's worker is pending, and then answers `verdict: "human"`
- **THEN** loop 2 claims again after the first answer and ends after the second, although loop 1's worker is still pending

#### Scenario: Workflow result
- **WHEN** the last claimer answer of the workflow carries `verdict: "stalled"` with zero counts and empty lists
- **THEN** the workflow result's `digest` is `{ verdict: "stalled", finished: false, stalled: true, claimable: 0, preparing: 0, working: 0, openQuestions: [], awaitingReview: [] }`

### Requirement: Work workflow: claimer agent: digest fields
A claimer that claims nothing SHALL return, with `claimed: false`, the fields of its last `wait` digest: `verdict`, `claimable`, `preparing` and `working` from `workByKind["claude-code"]`, with `openQuestions` and `awaitingReview`. It SHALL return before its third poll only when `verdict` is `finished`, `stalled` or `human`. Its answer SHALL carry no `finished`, `stalled` or `verifying`.

#### Scenario: Finished digest returns at once
- **WHEN** the first `wait` of a claimer answers a digest whose verdict for `claude-code` is `finished`
- **THEN** the claimer returns the six fields at once with `claimed: false`, without a second poll

#### Scenario: Open question keeps the claimer polling
- **WHEN** each `wait` answers a digest whose verdict for `claude-code` is `standby` while a question is open
- **THEN** the claimer claims again until three polls are done and then returns the fields of the last digest

#### Scenario: Human verdict returns at once
- **WHEN** a `wait` of a claimer answers a digest whose verdict for `claude-code` is `human`
- **THEN** the claimer returns the six fields at once with `claimed: false`

## ADDED Requirements

### Requirement: Work workflow: loop end: digest without a verdict
When the claimer finds no `workByKind` in the `wait` digest it SHALL return `{ claimed: false }` with no `verdict`. A claimer answer with `claimed: false`, no `verdict` and no non-empty `error` SHALL end its loop, logging `<workerId>: the wait digest holds no work verdict (an older daemon), loop ends`. The script SHALL NOT fall back to a stop rule of its own.

#### Scenario: Bare answer ends the loop
- **WHEN** the claimer of loop `work-1` answers `{ claimed: false }`
- **THEN** the loop ends after that one claimer and the log holds `work-1: the wait digest holds no work verdict (an older daemon), loop ends`

#### Scenario: Empty error ends the loop the same way
- **WHEN** the claimer of loop `work-1` answers `{ claimed: false, error: "" }`
- **THEN** the loop ends after that one claimer with the same log line

## REMOVED Requirements

### Requirement: Work workflow: claimer agent: stop rule in the script
**Reason**: the stop rule exists once, in the daemon, as the work verdict per runner kind (`workByKind`); the script reads the `claude-code` verdict instead (see "Work workflow: loop end").
**Migration**: none for users; a daemon older than the work verdict ends each loop after its first claimer that claims nothing, so update the daemon with the plugin.
