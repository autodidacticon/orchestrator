## 1. Termination steps

- [x] 1.1 `src/worker/terminate.ts`: `stopAgent` (SIGTERM to the group, SIGKILL after the limit), `commitWorkInProgress`, `pushHead` (bounded, 30 s), `handBack` answering its outcome as data, `handBackExitCode`

## 2. Loop

- [x] 2.1 `runCommand` starts the agent in a process group of its own and returns a handle (exit and pipes closed)
- [x] 2.2 `WorkerDeps.termination`; the entry point aborts it on SIGTERM and SIGINT; `terminating` line
- [x] 2.3 Idle exit, claim in flight, launch released without keep before its agent starts
- [x] 2.4 After the agent: heartbeat wait bounded at 5 s, the short retry window for every call, the relay's push bounded, hand-back of a held launch, exit codes
- [x] 2.5 `ORCH_WORKER_AGENT_STOP_MS` in `workerSettings` (only when set) and `USAGE`

## 3. Deployment and docs

- [x] 3.1 `deploy/base/worker.yaml`: `terminationGracePeriodSeconds: 120`, no preStop hook
- [x] 3.2 `deploy/README.md` "The workers"

## 4. Tests

- [x] 4.1 `test/slice/worker-termination.test.ts` with the agent `test/agents/slow-agent.ts`
- [x] 4.2 `test/host/worker-termination.test.ts`
