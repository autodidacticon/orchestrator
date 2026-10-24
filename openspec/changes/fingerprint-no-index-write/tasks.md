## 1. Code

- [x] 1.1 `GitWorkspace.fingerprint` hashes `git diff-index -p HEAD` with the `.orchestrator` exclusion in place of `git diff HEAD`
- [x] 1.2 The comment on the git wrapper's environment says `GIT_OPTIONAL_LOCKS=0` covers `git status` but not porcelain `git diff`

## 2. Tests

- [x] 2.1 Real-git test: after a content-preserving touch of tracked files, three fingerprints leave `.git/index` with the same inode and mtime, create no `index.lock`, and equal the clean fingerprint; porcelain `git diff HEAD` as a control rewrites the index
- [x] 2.2 Real-git test: the fingerprint changes on a content edit and an untracked file, ignores edits under `.orchestrator/`, and never writes the index
- [x] 2.3 The daemon's git wrapper runs commands with `GIT_OPTIONAL_LOCKS=0`
