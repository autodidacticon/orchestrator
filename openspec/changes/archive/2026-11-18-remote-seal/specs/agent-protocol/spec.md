## MODIFIED Requirements

### Requirement: Submission sealing
On `report submit` the orchestrator SHALL inspect the worktree, ignoring `.orchestrator/`. Under the launch's `agent` commit policy, a worktree with uncommitted or untracked changes SHALL be rejected with 409 and the list of files, and the task SHALL remain `running`. Under `daemon`, the orchestrator SHALL commit those changes on the launch branch: author and committer `orchestrator`, hooks skipped, the report summary as the message. It SHALL then seal the new head, and the `agent.report` event SHALL carry `committedByOrchestrator: true`. Under either policy, a clean worktree SHALL NOT be committed. Once the worktree is clean or committed, the branch head SHALL be recorded as `sealedSha` and the task SHALL become `submitted`. Commits made after sealing SHALL be ignored by verification. On a remote launch the daemon holds no worktree: the submit report SHALL carry `sealedSha`, the full object name of the launch branch tip the worker pushed to origin, and the orchestrator SHALL seal it as the `remote-workspace` capability's "Seal" requires instead of inspecting a tree; the commit policy does not apply. A remote submit without `sealedSha`, or with a value that is not a full hex object name, SHALL answer 400 naming `sealedSha` and record nothing. On a local launch `sealedSha` in the report SHALL be ignored. A refused seal, local or remote, SHALL record no `agent.report` event and no deduplicated response, so the same `seq` may be sent again.

#### Scenario: Dirty worktree rejected
- **WHEN** an agent of a launch with the `agent` policy submits with an unstaged modification to `src/a.ts`
- **THEN** the response is 409 listing `src/a.ts` and the task is still `running`

#### Scenario: Dirty worktree committed by the daemon
- **WHEN** an agent of a launch with the `daemon` policy writes `T1.txt` and submits without committing
- **THEN** the response is 200, the launch branch head is a commit by `orchestrator` holding `T1.txt`, `sealedSha` is that head, and `agent.report` carries `committedByOrchestrator: true`

#### Scenario: Later commits ignored
- **WHEN** an agent submits at commit C1 and then commits C2 on the same branch
- **THEN** verification uses C1

#### Scenario: Remote submit without sealedSha
- **WHEN** the worker of a remote launch submits without `sealedSha`
- **THEN** the response is 400 naming `sealedSha`, no `agent.report` event is appended, and the task is still `running`

#### Scenario: Local submit ignores sealedSha
- **WHEN** an agent of a local launch commits C1 and submits with `sealedSha` set to any other value
- **THEN** the submission is sealed at C1 from the worktree and the task is `submitted`
