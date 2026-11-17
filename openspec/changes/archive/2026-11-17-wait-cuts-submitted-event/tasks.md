## 1. Events route

- [x] 1.1 `src/operator/review.ts`: `cutSubmittedEvent` (by `cutStat` and `cutSummary`) and `parseCutSubmitted`
- [x] 1.2 `GET /v1/events` reads `cutSubmitted` and maps the served events through `cutSubmittedEvent` with the daemon's `review` cuts; the cursor is unchanged

## 2. Wait tool

- [x] 2.1 The poll sends `cutSubmitted=true`; the description says a submitted event comes cut

## 3. Comment

- [x] 3.1 `submittedBody` returns the short notice; the `submitted` case in `deriveEffects` passes only id, sha and version

## 4. Tests

- [x] 4.1 Slice: cut, whole, refused, other events, stored event (`test/slice/events.test.ts`); `wait` returns `omitted` (`test/slice/operator-mcp.test.ts`)
- [x] 4.2 Comment: notice content and a 24-task bound (`test/loop/tracker-effects.test.ts`), no task line (`test/slice/tracker-sync.test.ts`)
