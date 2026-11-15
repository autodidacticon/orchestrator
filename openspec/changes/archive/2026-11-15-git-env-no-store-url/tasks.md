## 1. Git environment

- [x] 1.1 `gitEnv` in `src/workspace/git.ts`: `process.env`, the fixed git settings and the caller's overrides, filtered by `withoutStore`, built per call
- [x] 1.2 `git` and the bounded remote path use `gitEnv`; the import-time `baseEnv` is gone

## 2. Spec

- [x] 2.1 MODIFIED `state-backend` "No store URL in child environments": the daemon's git commands and their hooks are covered

## 3. Tests

- [x] 3.1 A post-commit hook run by the kept-release WIP commit (`preserve`) prints no store variable or password, and still sees the three fixed git settings
- [x] 3.2 A pre-commit hook run by a daemon `git commit`, and `env` through the plain and bounded git paths, print no store variable
- [x] 3.3 A store URL withheld after import is removed, and a variable changed after import is read as changed
