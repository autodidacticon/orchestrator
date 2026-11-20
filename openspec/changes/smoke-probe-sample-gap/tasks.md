## 1. Smoke script

- [x] 1.1 `now_ms`; `probe_sample` writes the millisecond time of each daemon sample that counts to `daemon-ms`
- [x] 1.2 `probe_gap`; `probe_summary` prints the longest gap; `probe_held` fails when it is `M5_GAP_MS` (4000 ms) or more
- [x] 1.3 The comment on `M5_CHECK_S` names the fixture and the test that ties them

## 2. Tests and docs

- [x] 2.1 `test/host/smoke.test.ts`: the gap rule, `probe_sample` with a stub `kc`, and `M5_CHECK_S` × 1000 against the fixture's wait
- [x] 2.2 `README.md` holds no Linear project key; `deploy/README.md` states the gap rule
- [x] 2.3 `bash deploy/smoke.sh --fresh` ends with `smoke: ok`; `npm test` is green
