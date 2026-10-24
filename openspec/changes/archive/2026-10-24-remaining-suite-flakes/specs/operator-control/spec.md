## MODIFIED Requirements

### Requirement: Status report
`status` SHALL report the `ready`, `running`, `waiting`, `submitted`, `blocked`, and `external` sets, `stallRoots`, `awaitingReview`, `verifying`, `openQuestions`, whether the run is `finished` or `stalled`, whether it is paused, any `graphRejected` reasons, the active graph revision, any foreign commits, the run directory, the graph file path, the daemon's pid and URL, the latest event sequence number, and `claimableByKind`: the number of claimable launches per runner kind, every kind present, beside the unchanged `claimable` list. `awaitingReview` SHALL list every submitted node; `verifying` SHALL list the tasks among them, which await the verifier and not a human, as the event digest's `verifying` does. The event digest SHALL carry `claimableByKind` beside its `claimable` count.

#### Scenario: Stalled run names its roots
- **WHEN** the run is stalled on a failed T1
- **THEN** `status` shows `stalled` true and `stallRoots` containing T1 with its reason

#### Scenario: Rejected reload is visible
- **WHEN** the last reload was incompatible
- **THEN** `status` shows `graphRejected` with the reasons and the revision still in force

#### Scenario: Run facts are reported
- **WHEN** `status` is requested
- **THEN** it includes the run directory, graph path, daemon pid and URL, and the latest event sequence number

#### Scenario: Claimable launches counted per kind
- **WHEN** one launch is parked for `claude-code` and one for `codex`
- **THEN** `status.claimable` lists both tasks and `status.claimableByKind` is `{ "claude-code": 1, "codex": 1 }`, and the digest shows `claimable: 2` with the same `claimableByKind`

#### Scenario: Verifying tasks are told apart from reviews
- **WHEN** task T1 is submitted and awaiting its check and milestone MVP is submitted
- **THEN** `status.awaitingReview` lists T1 and MVP, `status.verifying` lists T1 only, and the digest's `awaitingReview` lists MVP and its `verifying` lists T1
