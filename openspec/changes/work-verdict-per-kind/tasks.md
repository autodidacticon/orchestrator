## 1. The rule

- [x] 1.1 `src/loop/verdict.ts`: `WORK_VERDICTS`, `workVerdict`, `workByKindOf`, `emptyWorkByKind`, `strongestVerdict`, type imports only

## 2. The bodies

- [x] 2.1 `status()` builds `workByKind` from `claimableByKind`, `preparingByKind` and the working launches
- [x] 2.2 `digestOf` passes it through; the digest and status bodies without a graph carry every kind as `idle` or `paused`
- [x] 2.3 The `status` and `wait` tool descriptions name `workByKind`

## 3. Tests

- [x] 3.1 `test/loop/work-verdict.test.ts`: the table, the order, status per kind, working launches, run-level classes, parity with `stopVerdict`
- [x] 3.2 `test/slice/work-verdict.test.ts`: status, events digest and `wait` agree; bodies without a graph
- [x] 3.3 `test/slice/operator-mcp.test.ts`: both descriptions contain `workByKind`
- [x] 3.4 `openspec validate work-verdict-per-kind --strict`
