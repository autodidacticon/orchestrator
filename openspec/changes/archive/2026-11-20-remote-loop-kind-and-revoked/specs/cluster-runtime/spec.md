## ADDED Requirements

### Requirement: Claude worker image: runner kind
The Claude worker image SHALL set `ORCH_WORKER_RUNNER=claude-code` beside its `ORCH_WORKER_COMMAND`, so its workers claim only launches prepared for Claude Code.

#### Scenario: Runner kind asserted without a Docker daemon
- **WHEN** `test/host/worker-image.test.ts` reads `deploy/worker-claude/Dockerfile`
- **THEN** its environment sets `ORCH_WORKER_RUNNER` to `claude-code`
