## 1. Smoke script

- [x] 1.1 The in-pod probe script takes `comm` from the second read
- [x] 1.2 `probe_summary`; `probe_held` fails when the slowest round is not shorter than `M5_CHECK_S` (5 s) or no round finished
- [x] 1.3 `cleanup` prints the probe summary when the script exits non-zero before `probe_held`
- [x] 1.4 `m5_verifier_logs` requires exactly two BREAK job ids

## 2. Tests and docs

- [x] 2.1 `test/host/smoke.test.ts`: the probe against a fake `/proc`, `probe_held`, `cleanup` and `m5_verifier_logs` with stubs
- [x] 2.2 `README.md` links the verifier-pool spec; `deploy/README.md` names #34 and states the new rules
- [x] 2.3 `bash deploy/smoke.sh --fresh` ends with `smoke: ok`; `npm test` is green
