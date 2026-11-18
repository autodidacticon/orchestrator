## 1. Configuration

- [x] 1.1 `git.workerOriginUrl` in `src/config.ts`; `git.originUrl` and the run id unchanged

## 2. Claim

- [x] 2.1 Remote claim response without `worktree` and `briefPath`, with `access`, `repoUrl`, `integrationBranch`, `brief` and `briefMarkdown` from the row, and `carry` for an `interrupted` context
- [x] 2.2 No baseline fingerprint for a remote claim

## 3. Tests

- [x] 3.1 `test/loop/remote-claim.test.ts`: fields, `repoUrl` precedence, repeated claim, carry, no fingerprint
- [x] 3.2 `test/slice/remote-claim.test.ts`: clone `repoUrl` and compare `origin/<integrationBranch>` with `baseSha`
