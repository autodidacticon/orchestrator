## 1. Diagnosis

- [x] 1.1 Reproduce the ENG-2 double launch under parallel load and record the events and agent log before the second launch (design.md).

## 2. Implementation

- [x] 2.1 Daemon git commands run with `GIT_OPTIONAL_LOCKS=0` (src/workspace/git.ts).
- [x] 2.2 The verifier slice's ORCH_HOME test waits for T1 `done` or its first job `failed`/`conflict`, not `attempts >= 1`.

## 3. Verification

- [x] 3.1 `npx vitest run` without `--retry` passes 5 consecutive full runs (2026-10-19: all five exited 0).

## 4. Specs

- [x] 4.1 health-monitoring "Worktree observation takes no index lock" (ADDED).
