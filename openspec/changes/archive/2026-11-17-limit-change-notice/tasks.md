## 1. Daemon

- [x] 1.1 `setConfig`: after every refusal, compare the three limits in force with the limits after the patch and build `changed`
- [x] 1.2 Collect the affected launches (`live`/`launching` holding the lease of a `running` or `waiting` task; `claimable`) and build each message with the elapsed time
- [x] 1.3 Queue the notices with `queueNotice` inside the transaction that writes the document
- [x] 1.4 Tests in `test/loop/health.test.ts`: one notice per launch, two limits in one notice, waiting and parked launches, no notice for an ended launch, another key or a refusal, a failed write leaves neither

## 2. Work loop

- [x] 2.1 `silenceLimitMs(optMs, claim, statusBody, previous)` with the rule's order; the two-argument call unchanged
- [x] 2.2 The watcher recomputes the limit from each 200 `status` and logs a change; the usage text says the limit follows `status`
- [x] 2.3 Tests in `test/host/work-loop.test.ts`: the pure rule, a raise during silence, `--max-silence-ms` pinning the old limit, `--help`

## 3. Skills

- [x] 3.1 The bullet "a launch needs more time" of each run skill: the daemon tells the worker through its inbox; Codex and OpenCode: the loop follows the new stuck limit unless started with `--max-silence-ms`
- [x] 3.2 Host tests assert on the bullet alone
