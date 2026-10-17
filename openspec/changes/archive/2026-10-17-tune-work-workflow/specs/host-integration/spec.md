## MODIFIED Requirements

### Requirement: Work skill and workflow
The plugin SHALL provide a `work` skill and a bundled workflow `workflows/work.js`. The skill SHALL call `start` with mode `pull` or `mixed`, check that a graph is loaded, choose a worker count no larger than the run's capacity, run the workflow with the worker count, the run's `capacity`, and a run tag, and when the workflow returns: present open questions to the user, answer them through `answer`, and re-run the workflow with the same run tag; invoke the review skill for milestones awaiting review; and stop when the digest reports finished, or stalled with nothing claimable. The workflow SHALL clamp the worker count to the `capacity` argument when one is given, logging the clamp, and SHALL fan out one loop per worker with `parallel`. Each cycle SHALL run a claimer agent on the model named by the `claimModel` argument at the effort named by `claimEffort`, defaulting to `claude-haiku-5-5` at `low`, labelled `claim <workerId>`; the claimer SHALL claim with the loop's worker id and, when nothing is claimable, SHALL wait for up to 90 seconds with `until: "any"`, read `status`, evaluate the stop rule, and claim again, up to three polls before returning without a launch. On a claim the loop SHALL run a worker agent labelled `work <workerId> <taskId>` with the claim's `model` and `effort` as the agent's model and effort options, whose prompt is composed from the brief plus tool instructions: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. A loop SHALL end when nothing is claimable, no loop holds a launch, and the digest reports finished, stalled, or an open question. Workflow results SHALL be short outcomes, never briefs or logs. The `work` and `run` skills SHALL document `claimModel` and `claimEffort` with their defaults and pass them only when the user asks for a different claimer, and SHALL say that workers edit worktrees under the run directory, outside the repository, so a session in `acceptEdits` mode prompts for each file there unless started with `--add-dir` for that directory.

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
