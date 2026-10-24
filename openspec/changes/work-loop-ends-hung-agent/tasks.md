## 1. Investigation

- [x] 1.1 Establish what the daemon does with a claimed launch whose agent is silent (stuck detection, lease expiry) and record it with event evidence in design.md.

## 2. Implementation

- [x] 2.1 `--max-silence-ms` and `silenceLimitMs(opt, claim)`: the option, else the claim's `health.stuckFailAfterMs`, else 45 minutes; 0 is off.
- [x] 2.2 A watcher per running agent: `launchState` from `GET /v1/status` every `--poll-ms`, `watchVerdict` to decide, `killGroup` (SIGTERM, SIGKILL after 5 s) to end the process group.
- [x] 2.3 After a terminated agent exits: release without keep when still held, leave the daemon's verdict otherwise; outcome `hung`, counted toward `--max-failures`; claim again.
- [x] 2.4 The signal path uses `killGroup`.
- [x] 2.5 `--help` and the header comment name `--max-silence-ms`.

## 3. Tests

- [x] 3.1 Host test, fake opencode that never writes and never exits (and ignores SIGTERM): the daemon expires the lease; the loop ends the process group and claims the relaunch, which finishes the task.
- [x] 3.2 The same with the daemon failing the launch as stuck.
- [x] 3.3 The same with `--max-silence-ms 5000` and stuck detection off and a long lease: the loop releases without keep and claims the next launch.
- [x] 3.4 Unit tests for `silenceLimitMs`, `launchState` and `watchVerdict`.
- [x] 3.5 The opencode and codex work e2es print the loop's stderr on failure.

## 4. Specs

- [x] 4.1 host-integration: "Work loop by runner kind" modified, "Work loop ends a hung agent", "Work loop silence limit" and "Work loop after ending an agent" added.
