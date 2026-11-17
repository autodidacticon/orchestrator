## 1. Code

- [x] 1.1 `src/verify/verifier.ts`: `GitVerifierOptions.prepareCommand` and `prepareTimeoutMs`; the prepare command in `run` before the check
- [x] 1.2 `src/main.ts`: pass `config.prepareCommand` and `config.prepareTimeoutMs` to the backend

## 2. Tests

- [x] 2.1 `test/slice/verifier.test.ts`: order and nothing published, non-zero exit and next brief, timeout, held output pipe, environment, declared no-op; no `launch.prepare*` event in any case
