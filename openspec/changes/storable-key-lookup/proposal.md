## Why

`storable-values` (ORC-88) rewrites a NUL character or a lone surrogate to U+FFFD in every string written to the store, and that includes key columns. Reads do not apply the rewrite. So a graph node, a claim's worker id or an attachment id holding such a character was stored under another id and never found again by its own. For example, a worker's next claim did not match `worker.id` on the launch it held. The review of CLOUD-M2 v2 found this by reading the code (ORC-98).

## What Changes

- One rule for ids: an id the store would rewrite is refused where it enters, not rewritten. A rewrite on read would still leave the graph holding the raw id while rows hold the rewritten one, and it would merge `a\u0000` with `a�`.
- `src/state/storable.ts` adds `hasUnstorable`, `unstorableIdMessage` and `assertStorableId`. They use the same pattern as `storableString`.
- `parseGraph` refuses a node `id` or `deps` entry holding a NUL or a lone surrogate, with the new code `unstorableId`, a message naming the field and the JSON-escaped id, and details `{ field, id }`. Every graph path parses through it. Schema issue messages also write the node id as a JSON string, so a NUL never reaches a message.
- `POST /v1/claims` refuses such a `workerId`, `taskId` or `attachment`, and `POST /v1/attachments` refuses such an `id`. Both answer 400 naming the field and write nothing, the claim event included.
- The store's rewrite stays as the backstop for every other string.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: ADDED "Storable ids", "Refused graph id" and "Refused request id".

## Impact

- `src/state/storable.ts`, `src/graph/load.ts`, `src/operator/routes.ts`.
- Tests: `test/state/storable-ids.test.ts`. It covers the check, graph refusals for NUL, lone high and lone low surrogates in ids and deps, and refusals over the real API on a SQLite store, a journal over a SQLite sink and a journal over Postgres. It also round-trips every key column with ids that pass, on each backend and across a reopen.
- Not covered, and not needed: ids taken from URL paths (`/v1/tasks/<id>/nudge`, `/v1/launches/<id>/...`, `/v1/attachments/<id>/end`) are matched against `url.pathname` in `src/agent/server.ts`, which is not percent-decoded. A path id therefore cannot hold a NUL or a lone surrogate (`%00` stays the three characters `%00`).
- `orch.claim` in `src/loop/orchestrator.ts` is reached only through the claim route, so the check sits in the route.
