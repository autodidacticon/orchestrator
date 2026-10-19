## Why

Without a run against the real CLI the runner, the classifier, the brief and the surfaces are verified only against fixtures. The free model makes the e2e runnable in CI at no cost, which the Codex e2e is not.

## What Changes

1. test/e2e/opencode.test.ts behind `ORCH_E2E_OPENCODE=1`, skipped when `opencode` is not on PATH: throwaway repo; daemon started with `runnerKind: opencode`, `opencode.model: opencode/big-pickle`, capacity 2, `permission: derived` (the check command `node --test` or the repo's npm test derived into patterns); a graph of three tasks: T1 writes a file and commits; T2 asks a `needsDecision` question after `block` has waited more than 60 s (the Codex M1 shape) and the test answers it; T3 depends on T1 and T2. Assertions: `finished: true`; every task `done`; one `Orchestrator-Task:` trailer per task on the integration branch; every launch row has `runner: opencode`, `tokens.input > 0`, `tokens.output > 0`, `costUsd` present (0), `source: 'opencode'`; one `launch.usage` event per launch; `status.cost.unpricedLaunches` is 0 (cost came from the stream); any launch whose `launch.failed` carries `reason: startupContended` did not increment its task's retry counter; no `needsAccess` question names `git commit` (the agent commits under `commit: agent`).
2. A second case under the same variable with `permission: derived` and a task whose brief requires a command outside the patterns: the launch raises a `needsAccess` question naming the command (the auto-reject surfaced as the brief instructs); the test answers it and the task finishes.
3. README Tests paragraph: "Seven opt-in tests use a real model" and the `ORCH_E2E_OPENCODE=1 npm test -- test/e2e/opencode` line, noting the free model and that no login is needed.
4. The e2e writes its launch logs to the test's temp dir and copies the first run's JSONL into `test/fixtures/opencode/e2e-<task>.jsonl` only on an explicit `ORCH_E2E_OPENCODE_RECORD=1`, never silently.

## Capabilities

- `health-monitoring`: modified: "Usage accounting"
- `task-lifecycle`: modified: "Health failure reasons"
- `worker-runners`: modified: "OpenCode runner command composition"

## Impact

* test/e2e/opencode.test.ts (new), README.md
* test/fixtures/opencode/e2e-*.jsonl (only when recorded)

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-63 edited `openspec/specs` directly in commit fc140b7 instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-63 issue text.

Commit summary: Added test/e2e/opencode.test.ts, the opt-in real-OpenCode e2e (ORCH_E2E_OPENCODE=1, skipped with a warning naming `opencode` when the binary is not on PATH). It runs a throwaway node repo, makeSlice with an OpenCodeRunner wired the same way as main.ts, runner.kind opencode, model opencode/big-pickle, capacity 2, permission derived, and checkCommand `node --test`. T1 commits hello.txt. T2 blocks with needsDecision and is answered after 75 s. T3 depends on both. Every Change-1 assertion is in place: trailers, launch rows, launch.usage, unpricedLaunches 0, the startupContended counter rule, and no needsAccess question naming git commit. Case 2 (needsAccess for an off-pattern command) is in the file but it.skip'd, as the operator decided at seq 2: opencode 1.18.30 ends a headless run right after an auto-rejected `ask`, so needsAccess cannot surface. Probe evidence is in test/fixtures/opencode/events/P-ask.jsonl/.err and P-deny.jsonl. ORCH_E2E_OPENCODE_RECORD=1 writes redacted e2e-<task>.jsonl, and those files from a passing run are committed. README: "Seven opt-in tests use a real model" plus the ORCH_E2E_OPENCODE line. New scenarios in worker-runners, health-monitoring and task-lifecycle.
