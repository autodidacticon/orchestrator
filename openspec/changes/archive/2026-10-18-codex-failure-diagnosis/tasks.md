## 1. Runner

- [x] 1.1 `src/runner/runner.ts`: `RunnerFailure`, `AgentRunner.readFailure?`; `src/runner/multi.ts` routes it by kind; `src/runner/inproc.ts` `failureScript`
- [x] 1.2 `src/runner/codex.ts`: `classifyCodexFailure` and `CodexRunner.readFailure` over the launch log
- [x] 1.3 `test/runner/codex.test.ts`: C, D, E, a sandbox denial (git2), a login failure, an exit before a turn, complete runs and a missing log

## 2. Dead launches

- [x] 2.1 `src/loop/orchestrator.ts` `exitedWithoutReport(launch, message)`; `src/loop/tick.ts` and `src/launch/recovery.ts` use it; `launch.ended` carries `runnerFailure`
- [x] 2.2 `src/brief/compose.ts`: the runner's diagnosis line under "Context from previous attempts"
- [x] 2.3 `test/loop/health.test.ts`: a scripted diagnosis in the failure, the event, and the next brief; a runner without `readFailure` unchanged

## 3. Finish

- [x] 3.1 Spec deltas for task-lifecycle and health-monitoring; `openspec/specs/` is updated when the change is archived
