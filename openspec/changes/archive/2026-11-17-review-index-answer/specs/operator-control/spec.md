## MODIFIED Requirements

### Requirement: Review bundle
`review` for a gated milestone in `submitted` SHALL answer in one of three views, named by the answer's field `view`, and every answer SHALL carry `milestone`, the pinned `integrationSha`, `reviewVersion` and the tag name, so that a caller making several calls can see a resubmission between them. In every answer `view` and `omitted` SHALL be serialised before `diffStat` and `closure`.

- **Index** (`view: "index"`, the default): `baseline` and the milestone's `acceptanceCriteria` as in the whole bundle; `diffStat`, the first `statLines` file lines of `git diff --stat <baseline>..<integrationSha>` as git printed them, then one line ` ... <k> more files` when k file lines were left out, then git's totals line, which is always kept (an empty stat stays empty); and for every task in the milestone's closure an entry with `taskId`, `title` (the payload's title, else the task id), `status`, `publishedSha`, `summary` cut to `summaryChars` UTF-16 units (one fewer when the cut would split a surrogate pair), `summaryLength` (the whole summary's length), `acceptanceCount` (the evidence items of its report) and `changedFileCount` (the published job's changed files, absent when the job records none). An entry SHALL NOT carry `acceptance`. A task with no submit report has an empty `summary`, `summaryLength` 0 and `acceptanceCount` 0. `omitted` SHALL list `{ field, count, fetch }` for each cut with a count above 0: `closure.acceptance` with the number of tasks that have evidence, `closure.summary` with the number of summaries cut, and `diffStat` with the number of file lines left out. The `fetch` text of the closure elements SHALL name the tool argument `task`, the HTTP form `GET /v1/milestones/<id>/review?task=<taskId>` and `full=true`; that of `diffStat` SHALL be the command `git diff --stat <baseline>..<integrationSha>` with both shas.
- **One task** (`view: "task"`, parameter `task=<id>`): `omitted: []`, no `diffStat`, and `closure` with one entry: `taskId`, `title`, `status`, `publishedSha` when there is one, the task's own `acceptanceCriteria`, `changedFiles` when the published job has them, and from the task's latest submit report `summary`, `acceptance`, `interfaces`, `decisions`, `deviations`, `followUps`, `tests` and `noChanges`, but not `proposals`. A closure task with no submit report SHALL be answered 200 with none of the report's fields. This view SHALL make no git call.
- **Whole bundle** (`view: "full"`, parameter `full=true`): every key of the bundle the orchestrator builds, with `baseline`, the whole `diffStat` and every closure entry's `summary` and `acceptance`, plus `omitted: []`.

The cuts SHALL come from the config keys `review.statLines` (default 40) and `review.summaryChars` (default 400), integers of 0 or more read from the config file at daemon start; the request parameters `statLines` and `summaryChars` SHALL override them for one call, and 0 means none. The parameters SHALL be read as follows, and a refusal answered 400 with `{ ok: false, reason, parameter }` naming the parameter: `full` is the whole bundle only for `true`, no for `false` or absent, and refused for any other value; an empty `task`, `statLines` or `summaryChars` is refused; `statLines` and `summaryChars` must be integers of 0 or more, and are checked in every view but have no effect in the one-task and whole views; `task` together with `full=true` is refused. A request is checked in this order: no graph loaded (409), a refused parameter (400), a node that is not a milestone or a milestone not in `submitted` (409, naming the current status, also when `task` is given), and a `task` that is not a task in the milestone's closure (404 with `{ ok: false, reason, closure }`, the reason naming the id and `closure` listing the closure's task ids).

#### Scenario: Bundle for a submitted milestone
- **WHEN** MVP is submitted at version 2 over tasks T3 and T4, T3's summary is 1,000 characters, both have evidence, and the diff stat has 45 file lines
- **THEN** `review` returns `view: "index"`, the sha, version 2, tag `milestone/MVP/v2`, a diff stat of 40 file lines, ` ... 5 more files` and the totals line, two closure entries with a title, a summary of at most 400 characters with its `summaryLength` and an `acceptanceCount`, and `omitted` naming `closure.acceptance` 2, `closure.summary` 1 and `diffStat` 5

#### Scenario: One task
- **WHEN** `review` is called for MVP with `task=T3`
- **THEN** it returns `view: "task"`, the same sha, version and tag, `omitted: []`, no diff stat, and one entry with T3's own acceptance criteria and every field of its latest submit report but its proposals

#### Scenario: A task with no report
- **WHEN** T4 was cancelled with release, MVP is submitted, and `review` is called with `task=T4`
- **THEN** it answers 200 with an entry holding `taskId`, `title`, `status` and `acceptanceCriteria` and none of a report's fields

#### Scenario: Whole bundle
- **WHEN** `review` is called for MVP with `full=true`
- **THEN** it returns every key of the whole bundle with its values, `view: "full"` and `omitted: []`

#### Scenario: A task outside the closure
- **WHEN** `review` is called for MVP with `task=NOPE`
- **THEN** it answers 404 with a reason naming NOPE and `closure` listing T3 and T4

#### Scenario: A refused parameter
- **WHEN** `review` is called with `statLines=-1`, or with `task=T3&full=true`
- **THEN** it answers 400 naming `statLines`, or `full`

#### Scenario: A milestone that is not submitted
- **WHEN** `review` is called for a milestone that is running, with or without `task`
- **THEN** it answers 409 with an error naming the current status
