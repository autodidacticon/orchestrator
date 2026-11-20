## MODIFIED Requirements

### Requirement: Smoke M5 step: process probe
`deploy/smoke.sh` SHALL sample the processes under the daemon container's pid 1 and under each running verifier pod's pid 1 from the start of the M5 step until its third assertion has passed, and SHALL assert `M5: the check ran in a verifier pod and never under the daemon` from those samples.

#### Scenario: What one sample reads
- **WHEN** the probe takes a sample of a container
- **THEN** it runs one `kubectl exec` with only `sh`, `cat`, `sed`, `grep`, `tr` and `sleep`, which prints pid 1's command line and reads, twice and one second apart, the processes whose `PPid:` is 1 and whose `State:` is not `Z`, and reports each pid found in both reads whose `comm` at the second read is not `git`; it never looks for the text `sh -c`

#### Scenario: A child caught between fork and exec
- **WHEN** a child of pid 1 has `comm` `node` at the first read and `git` at the second
- **THEN** the sample does not report it, and a child whose `comm` is `node` at both reads is still reported

#### Scenario: Samples that do not count
- **WHEN** a sample's `kubectl exec` fails, or the second field of its pid 1 command line is not exactly `/usr/local/bin/orchestrator` (daemon) or `/usr/local/bin/orchestrator-verifier` (verifier)
- **THEN** the sample is printed and not counted, and the assertion does not fail on it

#### Scenario: The assertion
- **WHEN** the probe has stopped
- **THEN** the assertion holds when no daemon sample reported a child, at least one verifier sample did, at least five daemon samples were taken, and the slowest round was shorter than the fixture check's 5 s; it prints the three counts and the slowest round

#### Scenario: A slow round
- **WHEN** the slowest round took 5 s or longer, or no round finished
- **THEN** the assertion fails with a line naming the slowest round, or saying that no round finished

#### Scenario: The script stops before the assertion
- **WHEN** the script exits non-zero while the probe runs or before the assertion has run
- **THEN** `cleanup` stops the probe, prints its three counts and the slowest round on stderr, and removes its files; an exit 0, or an exit after the assertion printed them, prints nothing more

### Requirement: Smoke M5 step: failed jobs and verifier logs
`deploy/smoke.sh` SHALL assert `M5: the failed jobs are checkFailed with the check's output` from the rows that `pg_m5_jobs` reads in `orchestrator.verifier_jobs`, and `M5: verifier logs show the check` from the verifier pods' logs read with `--tail=-1`, whose lines `verifier <id> <event> <jobId> <taskId>` and check output show each check of the two M5 tasks.

#### Scenario: Two failed job rows
- **WHEN** `SMOKE-M5-BREAK` is blocked
- **THEN** `pg_m5_jobs`, filtered on this run's `run_id`, reads exactly two rows for it, each `failed` with `doc->>'failureKind'` `checkFailed` and a `doc->>'output'` that holds `fixture check: README.md names a task that breaks the check`

#### Scenario: The logs show each check
- **WHEN** the log assertion reads the verifier pods' logs, printing each verifier container's restart count
- **THEN** they hold a `check` and a `verified` line for `SMOKE-M5-PASS` with `fixture check: ok` in that check's output, and two `check` and two `checkFailed` lines for `SMOKE-M5-BREAK` naming the two job ids `pg_m5_jobs` read, each check's output holding `fixture check: README.md names a task that breaks the check`

#### Scenario: The log check needs the two job ids itself
- **WHEN** `pg_m5_jobs` does not read exactly two job ids for `SMOKE-M5-BREAK`, even with no `SMOKE-M5-BREAK` log lines to compare
- **THEN** the log assertion fails with a line giving the number of rows, whatever assertion ran before it
