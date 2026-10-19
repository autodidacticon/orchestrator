## Why

The run's check command uses `npx vitest run --retry 2`, which hid failures that reviewers of OPENCODE-M3 saw on most full runs without retries: the import slice launched ENG-2 twice, the verifier slice's ORCH_HOME test asserted `done` while a second attempt was still running, the codex work-loop slice timed out, and the e2e restart-adoption test was intermittent. Diagnosis (design.md) found one daemon bug behind the double launch: the progress fingerprint's `git status` / `git diff HEAD` refresh the launch worktree's index and hold `index.lock`, so an agent's concurrent `git commit` fails and the agent exits without a report. The scheduler then correctly charged a retry and relaunched.

## What Changes

1. `src/workspace/git.ts`: every daemon git command runs with `GIT_OPTIONAL_LOCKS=0`, so read-only observation of a live worktree never takes its index lock. Write commands still lock.
2. `test/slice/verifier.test.ts` "the check runs with an isolated ORCH_HOME": the wait ends when T1 is done or its first verifier job has failed, matching the assertion that follows, instead of on `attempts >= 1`, which a retry after an unrelated death also satisfies.
3. Spec: health-monitoring gains "Worktree observation takes no index lock".

No scheduler change: `src/loop/schedule.ts` admitted correctly in every reproduced failure.

## Capabilities

- `health-monitoring`: added: "Worktree observation takes no index lock"

## Impact

* src/workspace/git.ts (outside the task's listed scope: the defect is in the daemon's git wrapper, not the scheduler)
* test/slice/verifier.test.ts
