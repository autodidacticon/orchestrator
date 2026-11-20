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
- **THEN** the assertion holds when no daemon sample reported a child, at least one verifier sample did, at least five daemon samples were taken, the slowest round was shorter than the fixture check's 5 s, and no two counted daemon samples in a row were 4 s or more apart; it prints the three counts, the slowest round and the longest gap between counted daemon samples

#### Scenario: A slow round
- **WHEN** the slowest round took 5 s or longer, or no round finished
- **THEN** the assertion fails with a line naming the slowest round, or saying that no round finished

#### Scenario: The script stops before the assertion
- **WHEN** the script exits non-zero while the probe runs or before the assertion has run
- **THEN** `cleanup` stops the probe and prints its three counts, the slowest round and the longest gap on stderr; an exit 0, or an exit after the assertion printed them, prints nothing more

#### Scenario: The probe files on any exit
- **WHEN** the script exits for any reason, with any status, after the probe started
- **THEN** `cleanup` stops the probe and removes its files

## ADDED Requirements

### Requirement: Smoke M5 step: process probe: gap between counted daemon samples
The process probe SHALL take a millisecond wall-clock time just before the `kubectl exec` of each daemon sample and keep it only for a sample that counts, and the M5 probe assertion MUST fail when two counted daemon samples in a row are 4 s or more apart: the fixture check's 5 s (`M5_CHECK_S`) less 1 s for a sample's second read. A test SHALL fail when `M5_CHECK_S` × 1000 differs from the fixture check's wait in `deploy/overlays/kind/fixture/test.js`.

#### Scenario: A gap of 4 s or more
- **WHEN** two daemon samples in a row that count started 4000 ms or more apart, including when samples that do not count fall between them
- **THEN** the assertion fails with a line naming the gap in milliseconds, even when every round took less than 5 s

#### Scenario: Counted samples less than 4 s apart
- **WHEN** every two counted daemon samples in a row started less than 4000 ms apart, and the other conditions of the assertion hold
- **THEN** the assertion holds

#### Scenario: The check's length in two places
- **WHEN** `M5_CHECK_S` in `deploy/smoke.sh` × 1000 differs from the milliseconds the fixture's `test.js` waits
- **THEN** a test in `test/host/smoke.test.ts` fails
