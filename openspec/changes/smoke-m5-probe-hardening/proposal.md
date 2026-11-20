## Why

The review of the M5 Verifier pool milestone (#35) found four weaknesses in the smoke test's M5 checks. The process probe takes each child's `comm` from its first read, so a daemon child caught between fork and exec, which is a long-running `git` by the second read, is reported as a `node` child (a rare false failure). `probe_held` never checks that a round is shorter than the fixture check's 5 s, which the daemon side relies on. `cleanup` removes the probe's files without printing them, so an earlier M5 failure leaves nothing to read. `m5_verifier_logs` compares the BREAK log lines with the job rows, and with neither the comparison `"" = ""` passes. Two README lines are also out of date (#186).

## What Changes

- `deploy/smoke.sh`: the in-pod probe script reports a pid found in both reads by its `comm` at the second read. `probe_summary` prints the probe's counts, children, skipped samples and slowest round; `probe_held` calls it and also fails with a line naming the slowest round when that round took 5 s (`M5_CHECK_S`) or longer, or when no round finished. `cleanup` prints the summary on stderr when the script exits non-zero before `probe_held` ran. `m5_verifier_logs` fails unless `pg_m5_jobs` reads exactly two BREAK job ids.
- `README.md` links `openspec/specs/verifier-pool/spec.md` where it names the capability; `deploy/README.md` names the hardening issue #34 and describes the new rules.
- Tests in `test/host/smoke.test.ts` run the probe script against a fake `/proc`, and `probe_held`, `cleanup` and `m5_verifier_logs` with stubs.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `cluster-runtime`: MODIFIED "Smoke M5 step: process probe" and "Smoke M5 step: failed jobs and verifier logs".

## Impact

- Files: `deploy/smoke.sh`, `deploy/README.md`, `README.md`, `test/host/smoke.test.ts`.
- No source file changes.
