## MODIFIED Requirements

### Requirement: Tracker outbox
The daemon SHALL expose `outbox`, returning pending effects with `id` greater than `after` in `id` order, limited in count, together with the tracker policy; `ack`, marking an effect `applied` with the drainer's result; and `nack`, recording the error and either keeping the effect `pending` with `attempts` increased or marking it `failed` at `tracker.maxAttempts`. An unknown effect id SHALL be answered 404. The answers of `ack` and `nack`, including a repeated `ack` and the 409 for a `nack` of an applied effect, SHALL carry `effect` with only the effect's `id`, `taskId`, `kind`, `status` and `attempts`, plus `result` and `error` when the effect has them, and SHALL NOT carry its `payload`; `outbox` SHALL keep returning each effect with its `payload`. Both the CLI and the MCP server SHALL expose `outbox` and `ack`, the latter taking a result or an error. `status` SHALL additionally report `tracker` (the recorded kind and workspace, or none), `outboxPending` (the count of pending effects), and `trackerErrors` (every `failed` effect with its id, issue, kind, attempts, and error); the event stream digest SHALL carry `outboxPending` and `trackerErrors`.

#### Scenario: List then acknowledge
- **WHEN** two effects are pending and `ack` is posted for the first with result `{ commentId: "c1" }`
- **THEN** `outbox` returns only the second and `status` shows `outboxPending` 1

#### Scenario: Acknowledgement answer omits the payload
- **WHEN** `ack` is posted for a pending `comment` effect with result `{ commentId: "c1" }`
- **THEN** the answer's `effect` has the effect's `id`, `taskId`, `kind` `comment`, `status` `applied`, `attempts` and `result` `{ commentId: "c1" }`, and no `payload`, so the comment body is not returned

#### Scenario: Rejected effect retried then surfaced
- **WHEN** `nack` is posted for an effect three times with `maxAttempts` 3
- **THEN** the effect is returned by `outbox` after the first two, and after the third it is absent from `outbox` and present in `trackerErrors` with its last error

#### Scenario: Status reports the tracker
- **WHEN** a tracker of kind `linear` was recorded at import
- **THEN** `status` includes `tracker.kind` `linear`
