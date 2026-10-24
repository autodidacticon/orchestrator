## Why

ORC-73 set `GIT_OPTIONAL_LOCKS=0` for daemon git commands so the progress fingerprint would take no `index.lock`. That holds for `git status` but not for `git diff HEAD`: porcelain `git diff` runs `refresh_index_quietly`, which ignores optional locks. With git 2.55.0, after a touch that leaves a tracked file's content unchanged, `GIT_OPTIONAL_LOCKS=0 git diff HEAD` rewrites `.git/index` through `index.lock` (the CODEX-M5/OPENCODE-M4 review, ORC-77). Formatters, checkouts and installs leave such stat-dirty entries, and an agent's `git commit` can then fail on `index.lock: File exists` taken by the fingerprint, the ENG-2 double-launch cause ORC-73 diagnosed. The health-monitoring requirement and the comment in `src/workspace/git.ts` claimed both commands take no lock, and no test checked either claim.

## What Changes

- The fingerprint hashes `git diff-index -p HEAD -- . ':(exclude).orchestrator'` in place of `git diff HEAD`. `diff-index` is plumbing and never refreshes or writes the index. It still prints nothing for a stat-dirty file whose content matches HEAD, so a content-preserving touch does not change the fingerprint.
- health-monitoring "Worktree observation takes no index lock" names the commands the fingerprint runs, says porcelain `git diff` is not used and why, and gains a stat-dirty scenario. "Progress signals" names `git diff-index -p HEAD` and says a content-preserving touch is not progress.
- The comment on the git wrapper's environment says what `GIT_OPTIONAL_LOCKS=0` does and does not cover.
- Tests with a real git repository: a stat-dirty touch leaves `.git/index` with the same inode and mtime and creates no `index.lock`; the fingerprint still changes on content edits and untracked files and ignores `.orchestrator/`; the git wrapper passes `GIT_OPTIONAL_LOCKS=0`.

## Capabilities

### New Capabilities

### Modified Capabilities

- `health-monitoring`: "Progress signals" and "Worktree observation takes no index lock" name `git diff-index -p HEAD` in place of `git diff HEAD`.

## Impact

- `src/workspace/git-workspace.ts`, `src/workspace/git.ts`, `test/slice/workspace-fingerprint.test.ts`.
