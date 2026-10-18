## 1. Runner

- [x] 1.1 `DEFAULT_CODEX_COMMAND` in src/runner/command.ts
- [x] 1.2 `SubprocessRunnerOptions.extraVars`
- [x] 1.3 `CodexRunner`, `codexOverrides`, `defaultCodexApproval`, `codexSlots` in src/runner/codex.ts
- [x] 1.4 `shimCommand`, `shimEnv`, `formatEnvFile`, `parseEnvFile` in src/runner/shim-command.ts; the Claude runner uses them; `mcp.json` 0600
- [x] 1.5 Shim `--orch-env-file`; `agentEnv` carries `ORCH_RETRY_WINDOW_MS`
- [x] 1.6 `parseCodexUsage` and `CodexRunner.readUsage`
- [x] 1.7 Register the runner in main.ts; export from index.ts

## 2. Tests and fixtures

- [x] 2.1 test/fixtures/codex/ (reconstructed, see design.md)
- [x] 2.2 test/runner/codex.test.ts, test/health/usage.test.ts, test/toolchain/compose.test.ts, test/slice/shim.test.ts
