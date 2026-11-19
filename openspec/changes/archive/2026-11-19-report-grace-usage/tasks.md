## 1. Parser

- [x] 1.1 `parseUsage` tries line-start `{` first, then every `{`, each pass at most 200 tries
- [x] 1.2 `test/health/claude-result-line.test.ts`

## 2. Reap

- [x] 2.1 `killTree` waits for the process group of a leader; a non-leader keeps the wait for its pid
- [x] 2.2 `test/runner/kill-tree.test.ts`

## 3. Grace

- [x] 3.1 `health.reportGraceMs` default 120000; `test/runs/resolve.test.ts` expects it
- [x] 3.2 `test/loop/report-grace.test.ts`
