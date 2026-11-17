## Why

A Codex worker under `workspace-write` is told to run the check command and to ask with a `needsAccess` question for any command the sandbox refuses. The sandbox has no network, so a check command that installs packages or opens a port cannot run there, and the worker asks the operator. In run `9915d93d51e5ac9e`, as read on 2026-11-16, about 30 to 33 of 59 `needsAccess` blocks were network failures of the check and about 5 a refused write to a package store outside the worktree. The daemon runs the check command itself, outside any sandbox, on a clean checkout after the submit, so the worker can submit and let that check decide (ORC-84, task 84a).

## What Changes

- `BriefRunner` gets an optional `networkAccess` boolean. `briefInput` fills it for every `codex` launch from the effective configuration through `codexNetworkAccess(sandbox, networkAccess)` (`src/runner/selection.ts`): true under `danger-full-access`, true under `workspace-write` when `runner.codex.networkAccess` is true, false otherwise. Other kinds get no key. `brief.json` carries it under `runner.networkAccess`.
- The Definition of done of a `codex` brief gets one bullet after the check command bullet:
  - `networkAccess` false: the commands have no network access; run the parts of the check that work; when the rest cannot run for lack of network or for a refused write to a package store outside the worktree, do not ask and do not wait, submit, and name in the report summary each part that did not run and its error. It states that this is the exception to the `needsAccess` rule under Workspace, and that a login, a credential or a token stays a `needsAccess` question.
  - `networkAccess` true under `workspace-write`: names `runner.codex.networkAccess` as on, says a test that opens a port or local socket and an install writing to a package store outside the worktree may still be refused, with the same submit rule and the same login and credential exception.
  - `danger-full-access`, no `networkAccess` field, or another kind: no bullet.
- With a check command the bullet says the orchestrator runs the check itself, outside the sandbox, after the submit. Without one it leaves that out and speaks of the project's test suite.
- The check command bullet, the sandbox paragraph and the Reporting paragraph are unchanged. A brief composed from an input without `networkAccess` (the golden fixtures) is unchanged.

## Capabilities

### Modified Capabilities

- `agent-protocol`: ADDED requirement "Codex brief states the network limit".

## Impact

- `src/runner/selection.ts` (`codexNetworkAccess`), `src/workspace/workspace.ts` (`BriefRunner.networkAccess`), `src/loop/orchestrator.ts` (`briefInput`), `src/brief/compose.ts` (the bullet).
- Tests in `test/loop/brief.test.ts`, `test/loop/selection.test.ts` and `test/runner/selection.test.ts`.
- The cost: work can be submitted untested, and a failed daemon check spends an attempt. Tasks 84b (operator surfaces for `runner.codex.networkAccess`) and 84c (a daemon-side install step) are the ways to reduce it.
