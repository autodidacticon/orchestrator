## 1. Resolution

- [x] 1.1 `src/runs/resolve.ts`: `networkAccess` in `NAMESPACE_LEAVES.codex` and `codexOverridesSchema` (boolean, nullable)
- [x] 1.2 `parseSetFlags`: `codex.networkAccess` reads exactly `true` or `false`, else `--set codex.networkAccess expects true or false, not <raw>`
- [x] 1.3 `resolveLayers`: the leaf takes the override, and `config.runner.codex.networkAccess` carries the resolved value
- [x] 1.4 `foldRunnerArgs`: the flat `networkAccess` lands under `codex`

## 2. Operator surfaces

- [x] 2.1 `src/operator/mcp-server.ts`: `RUNNER_ARG_TEXT.networkAccess`; the argument on `start` (boolean) and `configure` (boolean or null); the `configure` sentence after the key list
- [x] 2.2 Usage texts in `src/main.ts` and `src/operator/cli.ts`

## 3. Skills

- [x] 3.1 The `configure` paragraph of the Claude Code, Codex and OpenCode run skills names `networkAccess`; the OpenCode block hash re-pinned

## 4. Tests

- [x] 4.1 `test/runs/resolve.test.ts`: resolution, `--set`, merge, fold
- [x] 4.2 `test/loop/config.test.ts`: `setConfig`, the 400, the clear, no effect under claude-code and a template without the slot
- [x] 4.3 `test/slice/codex.test.ts`: the flag on the command line, file true with override false, `read-only`
- [x] 4.4 `test/slice/codex-work.test.ts`: a claim made after the change carries the value
- [x] 4.5 `test/slice/config.test.ts`: the route, `config --set` and `--clear`, a refused value, the spawn path
- [x] 4.6 `test/slice/operator-mcp.test.ts` and the three host tests
- [x] 4.7 `test/e2e/codex-network.test.ts`: the opt-in probe against a real Codex (not run with the variable set)
