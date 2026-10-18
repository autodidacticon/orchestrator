## 1. Operator surfaces

- [x] 1.1 `src/runs/resolve.ts`: `foldRunnerArgs` puts `sandbox` under `codex` and `commit` under the namespace of the patch's `runnerKind` or of the kind in force
- [x] 1.2 `src/operator/cli.ts`: `config --runner-kind --sandbox --commit`, `--clear <ns>.<leaf>`, usage naming both kinds' defaults and the codex-only `ultra`
- [x] 1.3 `src/main.ts`: the `--set` key list names `runnerKind`, `model`, `effort`, and the dotted per-kind keys
- [x] 1.4 `src/operator/mcp-server.ts`: `start` and `configure` take `runnerKind`, `sandbox`, `commit`, `codex { model, effort }`, and the union effort enum; `start` defaults a codex run to `spawn` and reports `modeNote`; the `status` description names `runnerKind`

## 2. Docs

- [x] 2.1 run, work, and import skills: the kind in the toolchain line, no allow-list part for codex, `runner.kind`, `runner.codex.*`, `budgets.prices`, and codex worked only in `spawn` or `mixed`
- [x] 2.2 README: Codex CLI prerequisite, the yaml example, the cost sources

## 3. Tests and specs

- [x] 3.1 `test/slice/config.test.ts`, `test/slice/operator-mcp.test.ts`, `test/host/package.test.ts`
- [x] 3.2 Spec deltas for operator-control, operator-mcp, host-integration, and worker-runners; `openspec/specs/` is updated when the change is archived
