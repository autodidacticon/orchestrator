## ADDED Requirements

### Requirement: Interrupted context in the brief
When a task is relaunched after a release with `keep`, its brief SHALL carry an `interrupted` context with `priorLaunchId`, `priorBranch`, `headSha`, `reason`, and `wipCommit` when uncommitted changes were preserved. The brief SHALL state that the previous launch was interrupted for that reason, that the branch holds its work so far at that head and that the work-in-progress commit, when present, holds changes the previous worker had not committed, and SHALL instruct the agent to continue from that branch by merging or cherry-picking it onto the new base, or to inspect it and start over, and to squash the work-in-progress commit before submitting. The context SHALL be stored on the overlay entry at the release and cleared when the next launch goes live, like other attempt context, and SHALL coexist with a question and answer when the release happened while `waiting`.

#### Scenario: Brief names the kept branch
- **WHEN** T2's launch `L1` on branch `task/T2/l1` was released with `keep` at head H with a work-in-progress commit W and T2 is relaunched
- **THEN** T2's next brief carries `interrupted` with `priorLaunchId` L1, `priorBranch` `task/T2/l1`, `headSha` H, and `wipCommit` W, and states that the branch holds the work so far

#### Scenario: Context cleared at the next launch
- **WHEN** the relaunched T2 goes live
- **THEN** its overlay entry no longer carries `interrupted`

#### Scenario: Interrupted while waiting
- **WHEN** T3 was released with `keep` while `waiting` and is later answered and relaunched
- **THEN** its brief carries the question, the answer, and `interrupted`
