## ADDED Requirements

### Requirement: Review answer names the previous version

At review version n above 1, the index and the full answer of `GET /v1/milestones/<id>/review` SHALL carry a block `previous`, after `omitted` and before `diffStat`, naming version n-1, the sha it was pinned at (kv `tagged:<id>:<n-1>`, never the tag), the closure tasks added or republished since, and the diff stat between the two shas. The one-task answer SHALL NOT carry it. Nothing new SHALL be stored, and every other field SHALL stay as it is.

#### Scenario: Version 1 has no previous block

- **WHEN** a milestone submitted at review version 1 is reviewed with the index or the full answer
- **THEN** the answer has no `previous` key
- **AND** the one-task answer has no `previous` key at any version

#### Scenario: A later version lists the tasks added and republished

- **WHEN** a milestone is submitted at version n above 1, and kv `tagged:<id>:<n-1>` holds sha S
- **THEN** `previous` has `version` n-1, `sha` S and `tag` `milestone/<id>/v<n-1>`
- **AND** the closure of version n-1 is read from the milestone's second-to-last `transition` event with `to: "submitted"`, only when that event's `integrationSha` equals S
- **AND** `previous.tasksSince` lists `{ taskId, change }` for each current closure task that was not in that closure (`added`) or whose `publishedSha` differs from the one recorded there (`republished`), and no other task
- **AND** when that closure cannot be read, `tasksSince` is left out and `previous.tasksSinceUnavailable` is `true`
- **AND** `previous.diffStat` is the stat from S to `integrationSha`; the index cuts it by the stat limit of `diffStat` and adds `{ field: "previous.diffStat", count, fetch }` to `omitted`, with `git diff --stat S..<integrationSha>` as `fetch`; the full answer keeps it whole
- **AND** the block carries no outcome, rejection note or last accepted version

#### Scenario: The same commit at two versions

- **WHEN** a milestone is reset from `submitted` and resubmitted at the next version with no new commit, so that both versions have the same sha
- **THEN** `previous.sameCommit` is `true` and `previous.diffStat` is empty
- **AND** `previous.tasksSince` is `[]` when the closure did not change
- **AND** no git call is made for the previous sha

#### Scenario: No sha on record for the previous version

- **WHEN** kv `tagged:<id>:<n-1>` is absent
- **THEN** `previous` is `{ version, unavailable }`, where `unavailable` is a sentence saying no sha is on record, with no other key

#### Scenario: An empty stat between two shas

- **WHEN** `previous.sha` differs from `integrationSha` and git prints nothing for the stat between them, or the git call fails
- **THEN** `previous.diffStat` is empty
- **AND** `previous.diffStatNote` names `previous.sha` and says that either no file differs or that commit is not in the daemon's clone
