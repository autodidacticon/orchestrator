## Why

A milestone resubmitted at a later review version was shown as if it were new: the diff stat ran from the run's baseline and nothing said which tasks were new. Measured on one milestone, the stat from the baseline was about 36,000 to 38,000 bytes at versions 2 to 4 (614 files at version 4), while the stat since the previous version was 7,492, 6,337 and 4,887 bytes (119, 106 and 77 files). At version 4 seven of 24 tasks were new (ORC-127).

## What Changes

- At review version n above 1, the index and the full answer of `GET /v1/milestones/<id>/review` carry a block `previous`, placed after `omitted` and before `diffStat`. The one-task answer does not. At version 1 there is no `previous` key.
- `previous.version` is n-1, `previous.tag` is `milestone/<id>/v<n-1>`, and `previous.sha` is read from kv `tagged:<id>:<n-1>`. The comparison uses the sha, never the tag.
- `previous.tasksSince` lists the closure tasks added (`change: "added"`) or published again (`change: "republished"`) since version n-1. The closure of version n-1 is read from the milestone's second-to-last submitted transition event, and only when that event's `integrationSha` equals `previous.sha`. When it cannot be read, `tasksSince` is left out and `previous.tasksSinceUnavailable` is `true`.
- `previous.diffStat` is `git diff --stat <previous.sha>..<integrationSha>`. The index cuts it to `statLines` like `diffStat`, and a cut adds `{ field: "previous.diffStat", count, fetch }` to `omitted`. The full answer keeps it whole.
- Equal shas: `previous.sameCommit` is `true`, `previous.diffStat` is empty, and no git call is made. Different shas with empty git output: `previous.diffStatNote` says that either no file differs or the earlier commit is not in the daemon's clone.
- No sha on record: `previous` is `{ version, unavailable }`.
- Nothing new is stored. `diffStat`, `baseline`, `closure` and every other field are unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities
- `operator-control`: ADDED "Review answer names the previous version".
