## 1. Runner filter

- [x] 1.1 Parse `ORCH_WORKER_RUNNER` into `runnerKinds`; refuse a value outside the kinds naming the variable
- [x] 1.2 Send `runner` on every claim (a string for one kind, a list for several); unset sends none
- [x] 1.3 The start warning for a `command` loop without the variable; `USAGE` names it
- [x] 1.4 `deploy/worker-claude/Dockerfile` sets `ORCH_WORKER_RUNNER=claude-code`

## 2. Revoked launch

- [x] 2.1 `startLoopHeartbeat` calls `onRevoked` on a 401
- [x] 2.2 Race the command agent against termination and the watch; one `stopAgent`; `agent-ended` line
- [x] 2.3 Status read once after the 401: report grace (`reportGraceMs`, default 30000) when submitted or done, at once otherwise

## 3. Tests and docs

- [x] 3.1 `test/worker/loop.test.ts`: settings, claim bodies, warning
- [x] 3.2 `test/slice/worker-revoked.test.ts` and `test/agents/linger-agent.ts`
- [x] 3.3 `test/host/worker-image.test.ts` and `deploy/README.md`
- [x] 3.4 `openspec validate remote-loop-kind-and-revoked --strict`
