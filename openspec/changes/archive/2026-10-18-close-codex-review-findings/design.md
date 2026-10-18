# Design

## Claims

`zeroByKind()` lives in `src/runner/selection.ts` next to `RUNNER_KINDS`, so the status route's two no-graph literals and the orchestrator's `countByKind` build the same map from one list. The claims route passes `body['runner']` through unchanged; `claim()` already turns any value outside the kinds, `null` and `[]` included, into a 400 naming the kinds. Only an absent key means "any kind". The MCP `claim` tool's schema admits only the kinds or a list of them, so it needed no change.

## Overrides

`foldRunnerArgs` now throws when a flag sets a leaf under a namespace that the same call clears (`codex: null` with `--sandbox`), or sets a leaf that the same call clears (`codex: { sandbox: null }` with `--sandbox`). Clearing a different leaf of the same namespace still folds. The CLI surfaces the error through its existing `.catch` (exit 2, the message on stderr), the MCP `configure` tool through `guarded()`; the configure tool cannot send a namespace `null`, so only the CLI reaches the first case. The CLI also refuses `--clear runnerKind --commit <policy>` without `--runner-kind`, because binding the policy to the outgoing kind (read from `GET /v1/config` before the clear applies) is never what the operator meant.

## Dead code

`SubprocessRunnerOptions.extraVars` had no caller after codex-work-loop moved the Codex runner onto `compose`; the field, its spread in `spawn`, the `command` doc comment, and the `Omit` in `codex.ts` are gone. toolchain-discovery "Runner command composition" now describes `compose` as the way a runner with slots of its own composes the command.

## Codex host test

The two checks that run the installed `codex` (`codex mcp get` against the template in a scratch `CODEX_HOME`, and `codex debug prompt-input` rendering the template's SessionEnd hook) are gated on `ORCH_E2E_CODEX_HOST=1`. They call no model and take under a second, but they tie the suite to the installed Codex version's config and hook behaviour, so they are opt-in like the other Codex checks; the ENOENT skip stays inside the gate for machines without `codex`. Run with the gate on 2026-10-18 against codex-cli 0.163.0: 10 tests passed, both codex checks included. Without the gate the file reports 8 passed and 2 skipped.

## README

The Tests paragraph counts six model tests and names the no-model `ORCH_E2E_CODEX_HOST=1` check.
