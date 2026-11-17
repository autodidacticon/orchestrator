## Why

An `ack` or `nack` answered with the whole stored effect, so a session that acknowledged a comment effect got the comment text back a second time. The drainer already has the payload from the `outbox` listing; the answer only needs to say which effect it was and where it stands (ORC-121).

## What Changes

- The four answers of the ack and nack routes (a first ack, a repeated ack, a nack, and the 409 for a nack of an applied effect) carry `effect` as `{ id, taskId, kind, status, attempts }` plus `result` and `error` when the stored effect has them. They no longer carry `payload`, `sourceSeq`, `createdAt` or `appliedAt`.
- The other fields stay: `ok`, `duplicate` on a repeated ack, `reason` on the 409. The status codes stay.
- The `outbox` listing is unchanged and keeps each effect's payload.
- The `ack` tool's description says the answer carries the effect's id and state and not its payload. Its input schema is unchanged.
- **BREAKING** for a script outside the repository that read `effect.payload` from an ack or nack answer; it should read the payload from the listing.

## Capabilities

### Modified Capabilities

- `operator-control`: MODIFIED requirement "Tracker outbox" states the fields of the ack and nack answers.

## Impact

- `src/operator/routes.ts` (one function building the short form, used by the four returns), `src/operator/mcp-server.ts` (the `ack` description).
- Tests in `test/slice/outbox.test.ts`, `test/slice/operator.test.ts` and `test/slice/operator-mcp.test.ts`.
- The store, the journal, the events, the CLI and the skills are unchanged.
