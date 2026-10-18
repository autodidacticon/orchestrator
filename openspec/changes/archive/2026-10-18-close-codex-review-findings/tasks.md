# Tasks

## 1. Claims

- [x] 1.1 `zeroByKind()` in `src/runner/selection.ts`; `routes.ts` uses it for both `claimableByKind` literals and `orchestrator.ts` `countByKind` builds on it
- [x] 1.2 `POST /v1/claims` passes `runner` through unchanged so `null` is refused with 400; test in `test/slice/claim.test.ts`; `status.claimableByKind` keys equal `RUNNER_KINDS` with no graph loaded

## 2. Overrides

- [x] 2.1 `foldRunnerArgs` refuses a cleared namespace or leaf that a flag sets in the same call; tests in `test/runs/fold.test.ts`
- [x] 2.2 `orchestrator-ctl config --clear runnerKind --commit x` without `--runner-kind` is refused with a message naming `--runner-kind`

## 3. Dead code and docs

- [x] 3.1 Remove `extraVars` from `SubprocessRunnerOptions`, `spawn`, and the `Omit` in `codex.ts`; toolchain-discovery delta names `compose`
- [x] 3.2 README Tests paragraph: six model tests plus the no-model `ORCH_E2E_CODEX_HOST=1` check

## 4. Codex host test

- [x] 4.1 Gate `codex mcp get` and the SessionEnd render on `ORCH_E2E_CODEX_HOST=1`, ENOENT skip kept inside; run once with the gate and record the result in design.md

## 5. Gate

- [x] 5.1 `npx vitest run test/slice/claim.test.ts test/runs/resolve.test.ts test/host test/runner` green, then the check command `npm ci --ignore-scripts && npm run build && npx vitest run --retry 2`
