## 1. Brief

- [x] 1.1 Remote Workspace section, interrupted line and fallback line in `composeBrief`; local text unchanged
- [x] 1.2 `remoteBrief` composes with `apiBaseUrl` and `.orchestrator/report.json`

## 2. Startup and admission

- [x] 2.1 `remoteAccessProblems` names an unset `apiBaseUrl` and a default kind whose commit policy is `daemon`; `Orchestrator.start()` checks the configuration in force
- [x] 2.2 Blocked kind and trigger `remoteNeedsAgentCommit`; admission blocks such a task on a remote run with no launch

## 3. Tests

- [x] 3.1 `test/loop/remote-brief.test.ts`
- [x] 3.2 `test/slice/remote-access.test.ts` remote runs set `apiBaseUrl`
