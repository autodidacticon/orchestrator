## Why

`deployment-identity` (ORC-87) removed the store connection from the environments of check commands and spawned agents, but the daemon's own git commands still inherited it. `src/workspace/git.ts` built their environment from `process.env` when the module loaded, so a kept-release work-in-progress commit, the verifier's rebase, and the project git hooks those commands run saw `DATABASE_URL`, `ORCH_RUN_ID` and any variable holding the store URL. The requirement "No store URL in child environments" named this gap.

## What Changes

- The environment of each daemon git command is built when the command runs: the daemon's environment, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, the caller's overrides, and then `withoutStore` from `src/runs/childEnv.ts`. `DATABASE_URL`, `ORCH_RUN_ID` and any variable whose value is a withheld store URL are removed, from both the plain and the time-bounded git paths.
- Because it is built per call, a store URL withheld after import (the daemon resolves its configuration after loading the module) is still removed.
- The `state-backend` requirement "No store URL in child environments" now covers the daemon's git commands and the hooks they run.

## Capabilities

### New Capabilities

### Modified Capabilities
- `state-backend`: "No store URL in child environments" extends to the daemon's own git commands and the project hooks they run.

## Impact

- `src/workspace/git.ts` (`GIT_FIXED_ENV`, `gitEnv`; `git` and the bounded remote path use it).
- Tests: `test/slice/git-env.test.ts`.
- Not covered: the three read-only git lookups in `src/runs/runDir.ts` (`config --get`, `ls-files`, `rev-parse`) still inherit `process.env`. They run no hooks, and that file is outside this task.
- The kept-release WIP commit runs with `--no-verify` (`src/workspace/git-workspace.ts`), so its pre-commit and commit-msg hooks do not run; its post-commit hook does, and is the one tested.
- Depends on `deployment-identity`, which adds the requirement this change modifies; archive that change first.
