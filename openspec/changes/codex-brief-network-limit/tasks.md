## 1. Brief input

- [x] 1.1 Add `codexNetworkAccess(sandbox, networkAccess)` beside `defaultCodexCommit` (`src/runner/selection.ts`)
- [x] 1.2 Add `networkAccess?: boolean` to `BriefRunner` (`src/workspace/workspace.ts`)
- [x] 1.3 Fill `networkAccess` in the codex spread of `briefInput`'s `runner` (`src/loop/orchestrator.ts`)

## 2. Brief composition

- [x] 2.1 Add the full bullet (`networkAccess` false) and the short bullet (`networkAccess` true under `workspace-write`) to the Definition of done of a `codex` brief, after the check command bullet, with the no-check-command variant (`src/brief/compose.ts`)

## 3. Tests

- [x] 3.1 `codexNetworkAccess` over the sandbox modes (`test/runner/selection.test.ts`)
- [x] 3.2 `briefInput` of a codex launch carries `networkAccess` under the default configuration and with `runner.codex.networkAccess: true` (`test/loop/selection.test.ts`)
- [x] 3.3 Composed briefs: full bullet, short bullet, no bullet under `danger-full-access`, another kind or no field, no check command (`test/loop/brief.test.ts`)
- [x] 3.4 Golden briefs under `test/fixtures/brief/` unchanged
