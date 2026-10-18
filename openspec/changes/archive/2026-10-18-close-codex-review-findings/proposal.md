# Close the remaining CODEX-M1 and CODEX-M2 review findings

## Why

The per-task reviews of the two Codex milestones (2026-10-18) left five small findings open after the fixtures and classifier were fixed:

1. `status.claimableByKind` is written as a literal `{ 'claude-code': 0, codex: 0 }` in two places in `src/operator/routes.ts`, while the orchestrator derives the same map from `RUNNER_KINDS`; the lists drift when a kind is added. `POST /v1/claims` with `runner: null` is treated as "no filter" (`body['runner'] ?? undefined`) although pull-runner "Claim" says a value outside the kinds is refused with 400.
2. `foldRunnerArgs` in `src/runs/resolve.ts` drops a namespace clear when a leaf is set into the same namespace in one call: `--clear codex --sandbox read-only` folds to `{ codex: { sandbox } }` and the clear is lost. The daemon already refuses the equivalent `{ codex: null, model }` patch. The same handler binds `--commit` to the outgoing kind when `--clear runnerKind` is in the same call without `--runner-kind`.
3. `SubprocessRunnerOptions.extraVars` is dead: the Codex runner composes through `compose` and the Claude runner never used it. toolchain-discovery "Runner command composition" still says a runner-specific slot reaches the template through `extraVars`.
4. README's Tests paragraph says "Five opt-in tests use a real model" but lists six gates.
5. `test/host/codex-host.test.ts` shells out to whatever `codex` is on PATH for `codex mcp get` and for a SessionEnd hook render, with only an ENOENT skip, so any other failure of the installed Codex fails the unit suite.

## What changes

- A `zeroByKind()` helper beside `RUNNER_KINDS` feeds both status literals and `countByKind`; the claims route passes `runner` through as given, so `null` is refused with 400 like any other value outside the kinds.
- `foldRunnerArgs` refuses a call that clears a key and sets a leaf under it (`--clear codex --sandbox x`, `--clear codex.sandbox --sandbox x`), and the CLI refuses `--clear runnerKind` together with `--commit` unless `--runner-kind` names the kind to bind to. Both are errors the surfaces report, not silent folds.
- `extraVars` is removed from the subprocess runner; the spec sentence moves to the `compose` hook.
- The README counts six model tests and names the no-model Codex host check.
- The two codex-shelling tests are opt-in under `ORCH_E2E_CODEX_HOST=1` (no model, local `codex` only), keeping the ENOENT skip inside the gate.

## Scope

pull-runner "Claim" (MODIFIED: a null-filter scenario), operator-control "Configuration route" (MODIFIED: the refusal rule), toolchain-discovery "Runner command composition" (MODIFIED: `compose` instead of `extraVars`). Code: `src/operator/routes.ts`, `src/runner/selection.ts`, `src/loop/orchestrator.ts`, `src/runs/resolve.ts`, `src/operator/cli.ts`, `src/runner/subprocess.ts`, `src/runner/codex.ts`, README, the four tests.
