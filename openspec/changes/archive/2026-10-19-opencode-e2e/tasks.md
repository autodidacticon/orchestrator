## 1. Implementation

- [x] 1.1 test/e2e/opencode.test.ts behind `ORCH_E2E_OPENCODE=1`, skipped when `opencode` is not on PATH: throwaway repo; daemon started with `runnerKind: opencode`, `opencode.model: opencode/big-pickle`, capacity 2, `permission: derived` (the check command `node --test` or the repo's npm test derived into patterns); a graph of three tasks: T1 writes a file and commits; T2 asks a `needsDecision` question after `block` has waited more than 60 s (the Codex M1 shape) and the test answers it; T3 depends on T1 and T2. Assertions: `finished: true`; every task `done`; one `Orchestrator-Task:` trailer per task on the integration branch; every launch row has `runner: opencode`, `tokens.input > 0`, `tokens.output > 0`, `costUsd` present (0), `source: 'opencode'`; one `launch.usage` event per launch; `status.cost.unpricedLaunches` is 0 (cost came from the stream); any launch whose `launch.failed` carries `reason: startupContended` did not increment its task's retry counter; no `needsAccess` question names `git commit` (the agent commits under `commit: agent`).
- [x] 1.2 A second case under the same variable with `permission: derived` and a task whose brief requires a command outside the patterns: the launch raises a `needsAccess` question naming the command (the auto-reject surfaced as the brief instructs); the test answers it and the task finishes.
- [x] 1.3 README Tests paragraph: "Seven opt-in tests use a real model" and the `ORCH_E2E_OPENCODE=1 npm test -- test/e2e/opencode` line, noting the free model and that no login is needed.
- [x] 1.4 The e2e writes its launch logs to the test's temp dir and copies the first run's JSONL into `test/fixtures/opencode/e2e-<task>.jsonl` only on an explicit `ORCH_E2E_OPENCODE_RECORD=1`, never silently.

## 2. Record

- [x] 2.1 Spec edits landed in fc140b7; change directory reconstructed at archive time
