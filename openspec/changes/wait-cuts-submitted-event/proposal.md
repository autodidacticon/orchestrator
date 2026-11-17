## Why

A milestone's submission reached the session whole twice besides the review answer: in the `transition` event that `wait` returns, and in the ready-for-review tracker comment that `outbox` lists and the session posts. Each was about 70,000 characters for a milestone of 24 tasks (ORC-123).

## What Changes

- `GET /v1/events` takes `cutSubmitted`. With `true` it serves a milestone's submitted `transition` event (payload `to: "submitted"` with a `diffStat` or a `closure`) with the cuts of the review index: `diffStat` cut to `review.statLines` file lines and git's totals line, each closure `summary` cut to `review.summaryChars` with `summaryLength` beside it, and an `omitted` list naming the `review` tool. Absent or `false` serves every event whole, as before; any other value is a 400 naming the parameter. The cut is by name, never by size, and is made on a copy: the stored event is unchanged.
- The `wait` tool always sends `cutSubmitted=true`. Its input schema is unchanged; its description says a submitted event comes cut and that `review` holds the rest. A daemon older than this change ignores the parameter and returns the event whole.
- The ready-for-review comment is a short notice: its first line as before (milestone id, version, pinned sha, tag), then how to get the review (the `review` tool with the milestone id, or `orchestrator-ctl review <id>`). It has no diff stat and no task lines, and no config key. The accepted and rejected comments are unchanged. An effect derived before the upgrade and still pending keeps its long body, since the effect key and marker are unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities
- `operator-mcp`: MODIFIED "Wait tool".
- `operator-control`: ADDED "Cut submitted events on request".
- `tracker-sync`: MODIFIED "Comment effects".

## Impact

- `src/operator/review.ts` (`cutSubmittedEvent`, `parseCutSubmitted`, reusing `cutStat` and `cutSummary`), `src/operator/routes.ts`, `src/operator/mcp-server.ts`, `src/tracker/comments.ts`, `src/tracker/effects.ts`.
- `deploy/smoke.sh`, `hosts/codex/bin/work.mjs`, `src/loop/**` and `src/state/**` are unchanged.
- Tests: `test/slice/events.test.ts`, `test/slice/operator-mcp.test.ts`, `test/loop/tracker-effects.test.ts`, `test/slice/tracker-sync.test.ts`.
