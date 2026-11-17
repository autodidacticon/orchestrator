## ADDED Requirements

### Requirement: Review skill reads the index then each task
The `review` skill of each host SHALL key its reading on the `view` field of the `review` answer, never on the tool's argument list: read the index, then each closure task with `task`, and judge against that answer's `acceptanceCriteria`. Before deciding it SHALL check that every one-task answer carries the index's `integrationSha` and `reviewVersion`, else start again. Only the Claude Code edition SHALL hold a fan-out sentence, saying each reviewer fetches its own task.

#### Scenario: Index answer
- **WHEN** the answer has `view` `index`
- **THEN** the skill reads `omitted`, fetches each closure task with `task`, says `full` can be too large, and says `diffStat` is cut and runs against the run's baseline

#### Scenario: Answer without view
- **WHEN** the answer has no `view` field
- **THEN** the skill treats it as the whole bundle of an older daemon and says never to call per task

#### Scenario: Index answer and a tool without task
- **WHEN** `view` is `index` and the `review` tool has no `task` argument
- **THEN** the skill fetches `GET <daemonUrl>/v1/milestones/<id>/review?task=<taskId>` with `daemonUrl` from `status`, or updates the plugin

#### Scenario: Refused answer
- **WHEN** the client refuses an answer for its size, in any case
- **THEN** the skill saves it with `curl -s <daemonUrl>/v1/milestones/<id>/review` (`?full=true` for the whole bundle), reads the file in parts, and asks the user to run the command if the session refuses it

#### Scenario: Answer with previous
- **WHEN** the answer has `previous`
- **THEN** the skill reads `git diff <previous.sha>..<integrationSha>` and the tasks in `previous.tasksSince` (every closure task when `previous.tasksSinceUnavailable` is true), and says `accept` covers the whole pinned commit

#### Scenario: Previous version unavailable
- **WHEN** `previous.unavailable` is set
- **THEN** the skill reviews the whole closure as for a first version

#### Scenario: Whole-bundle entry
- **WHEN** the answer is a whole bundle (no `view`, or `view` `full`)
- **THEN** the skill reads each task's criteria from its tracker issue or its one-task answer, since the bundle's `acceptanceCriteria` is the milestone's

#### Scenario: Resubmitted milestone
- **WHEN** a one-task answer carries another `integrationSha` or `reviewVersion` than the index
- **THEN** the skill starts the review again
