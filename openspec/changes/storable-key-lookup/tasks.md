## 1. Id check

- [x] 1.1 `hasUnstorable`, `unstorableIdMessage` and `assertStorableId` in `src/state/storable.ts`, on the pattern `storableString` uses

## 2. Entry points

- [x] 2.1 `parseGraph` refuses an unstorable node id or dependency with code `unstorableId`; schema messages write ids as JSON strings
- [x] 2.2 `POST /v1/claims` refuses an unstorable `workerId`, `taskId` or `attachment` before the claim event; `POST /v1/attachments` refuses an unstorable `id`

## 3. Spec

- [x] 3.1 ADDED `state-backend` "Storable ids", "Refused graph id" and "Refused request id"

## 4. Tests

- [x] 4.1 Graph refusals for NUL, lone high and lone low surrogates in ids and deps, from JSON and YAML escapes
- [x] 4.2 Claim, attachment and graph refusals over the real API on SQLite, a journal over SQLite and a journal over Postgres: 400 naming the field, no event, no claim; a good worker id finds its launch on its next claim
- [x] 4.3 Every key column round-trips ids that pass, on each backend and across a reopen
