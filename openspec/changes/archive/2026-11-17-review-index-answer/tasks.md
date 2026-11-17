## 1. Config

- [x] 1.1 `review.statLines` (default 40) and `review.summaryChars` (default 400), integers of 0 or more, in `configSchema`

## 2. Answer

- [x] 2.1 `src/operator/review.ts`: `cutStat`, `cutSummary`, `indexOf`, `fullOf`, `parseReviewQuery` and `reviewAnswer`
- [x] 2.2 `GET /v1/milestones/<id>/review` reads `task`, `full`, `statLines` and `summaryChars`

## 3. Clients

- [x] 3.1 The `review` tool forwards `task`, `full` (only when true), `statLines` and `summaryChars` through `URLSearchParams`
- [x] 3.2 `orchestrator-ctl review <milestone> [--task <id>] [--full] [--stat-lines <n>] [--summary-chars <n>]`

## 4. Spec

- [x] 4.1 MODIFIED `operator-control` "Review bundle" and `operator-mcp` "Review tool"

## 5. Tests

- [x] 5.1 `test/operator/review.test.ts`: cuts, `omitted`, surrogate pairs, config keys, size at a 24-task shape, parameter rules
- [x] 5.2 `test/slice/events.test.ts`: index, one task, task with no report, whole bundle, 404, 400s, 409s, `review.summaryChars` from config
- [x] 5.3 `test/slice/operator-mcp.test.ts` and `test/slice/operator.test.ts`: tool schema and arguments, CLI command, an id that needs URL encoding
