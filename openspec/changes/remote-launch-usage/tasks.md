## 1. Usage helpers

- [x] 1.1 `src/worker/usage.ts`: `TailKeeper` (last 256 KiB of a stream) and `usagePostBody` (the post body from the kept text and the claim, or nothing)

## 2. Loop

- [x] 2.1 Feed the command agent's standard output to the keeper; parse it after the agent process has exited
- [x] 2.2 Post as the last step of a launch on every path; on termination only after a release that was answered
- [x] 2.3 The `usage` line on a recorded post; any other answer to stderr, verdict and exit code unchanged

## 3. Docs

- [x] 3.1 `deploy/README.md` "The workers"

## 4. Tests

- [x] 4.1 `test/worker/usage.test.ts`
- [x] 4.2 `test/slice/worker-usage.test.ts` with the agent `test/agents/usage-agent.ts`
