## MODIFIED Requirements

### Requirement: Recovery per boundary
On start, before the first tick, the orchestrator SHALL run idempotent recovery:
- a launch in `preparing` SHALL have any worktree removed and SHALL be retried;
- a launch in `launching` SHALL be treated as unknown: its token revoked, any process whose command line contains the launch id killed, its worktree removed, and a new launch of the same attempt started without increasing `attempts`;
- a launch in `live` whose process is alive SHALL be adopted with its lease intact;
- a launch in `live` whose process is dead and whose fallback file exists SHALL have the file applied;
- a launch in `live` whose process is dead with no fallback file, while its task is `running`, SHALL be failed through the same path as a death the tick observes (task-lifecycle "Retry and exhaustion"): it is recorded as a `launch.failed` event, and the task ends as `failed` with `attempts` increased unless the runner diagnoses `startupContended` within the `health.contendedRetries` allowance, in which case the task returns to `unstarted` with `attempts` unchanged;
- a verifier job in `queued`, `checking`, or `verified` SHALL have any temporary worktree removed and SHALL restart from `queued`;
- a verifier job in `publishing` SHALL be resolved by inspecting the integration branch for the launch trailer: present means record `published` and `done`, absent means requeue. With `git.pushIntegration` on, recovery SHALL fetch and inspect origin's integration branch first. A trailer only on the clone, at the job's `squashSha`, while origin is still at the job's `expectedHead`, SHALL be pushed once with that lease and recorded `published`. A lease that no longer holds SHALL undo the local compare-and-swap and requeue, as SHALL an origin that cannot be reached;
- a milestone tag SHALL be re-created idempotently, and with `git.pushIntegration` on, pushed to origin.

#### Scenario: Crash between spawn and pid record
- **WHEN** the daemon dies after spawning an agent but before recording its pid
- **THEN** on restart the launch is revoked, the orphan process is killed by launch id, and a new launch of the same attempt starts

#### Scenario: Crash after pid record
- **WHEN** the daemon dies after recording the pid and the agent is still running
- **THEN** on restart the launch is adopted and the agent's later report is accepted

#### Scenario: Crash after publish before record
- **WHEN** the daemon dies after the compare-and-swap succeeded but before `publishedSha` was recorded
- **THEN** on restart the trailer is found on the integration branch and the task is marked `done` without a second publication

#### Scenario: Crash before publish
- **WHEN** the daemon dies after squashing but before the ref update
- **THEN** on restart no trailer is found and the job is requeued, producing exactly one published commit in the end

#### Scenario: Contended death found at restart
- **WHEN** a running task's launch died while the daemon was down, left no fallback file, and the runner diagnoses `startupContended`, with the task under its `health.contendedRetries` allowance
- **THEN** recovery records one `launch.failed` event with `reason: startupContended` and `charged: false`, and the task is `unstarted` with `attempts` unchanged

#### Scenario: Other death found at restart
- **WHEN** a running task's launch died while the daemon was down, left no fallback file, and the runner gives any other diagnosis or none
- **THEN** recovery records one `launch.failed` event with `charged: true` and the task is failed with `attempts` increased

#### Scenario: Crash between swap and push
- **WHEN** the daemon dies after the local compare-and-swap succeeded but before the push to origin, with pushing on
- **THEN** on restart the squash is pushed to origin once, the task is `done`, a second recovery pushes nothing, and origin holds exactly one commit with the launch trailer
