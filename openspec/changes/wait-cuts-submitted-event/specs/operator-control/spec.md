## ADDED Requirements

### Requirement: Cut submitted events on request
`GET /v1/events` SHALL take `cutSubmitted`. With `true` it SHALL serve each `transition` event whose payload has `to: "submitted"` and a `diffStat` or a `closure` with the review index's cuts from the daemon's configuration and an `omitted` list, on a copy. No other event SHALL change, whatever its size, nor the cursor. Absent or `false` SHALL serve every event whole. Any other value SHALL be answered 400 naming `cutSubmitted`.

#### Scenario: Parameter set
- **WHEN** a gated milestone E was submitted under `review: { summaryChars: 5, statLines: 0 }` with a stat of more than one line and `GET /v1/events?kinds=transition&cutSubmitted=true` is called
- **THEN** E's submitted event keeps `from`, `to`, `actor`, `trigger` and `integrationSha`; its `diffStat` holds git's totals line and no file line of the stored stat; each closure entry keeps `taskId` and `publishedSha`, has a `summary` of at most 5 characters and a `summaryLength` equal to the stored summary's length; and `omitted` lists `{ field, count, fetch }` for `closure.summary` (summaries cut) and `diffStat` (file lines left out), each only when its count is above 0, with a `fetch` naming the `review` tool and E

#### Scenario: Nothing to cut
- **WHEN** no summary is longer than `review.summaryChars` and the stat has no more file lines than `review.statLines`
- **THEN** the submitted event's `omitted` is `[]`

#### Scenario: Other events and the store stay whole
- **WHEN** the same request is served
- **THEN** every other event, including a task's transition and events of other kinds, equals its stored form, the cursor is the one served without the parameter, and the stored event still holds the whole stat and summaries

#### Scenario: Parameter absent
- **WHEN** the same request is made without `cutSubmitted`, or with `cutSubmitted=false`
- **THEN** E's submitted event is served with a payload equal to the stored one

#### Scenario: Parameter refused
- **WHEN** the request is made with `cutSubmitted=yes`
- **THEN** it is answered 400 with `{ ok: false, reason, parameter: "cutSubmitted" }`
