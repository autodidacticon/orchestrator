## 1. Server

- [x] 1.1 `useRepo` returns the repository the call is bound to: its own `repo`, else the session's, else undefined for the server's default
- [x] 1.2 The `tool` wrapper passes each handler a client bound to that repository (`OperatorClient.at`); `repo`, `url`, `call` and `wait` take the bound repository explicitly
- [x] 1.3 Every slice of `wait` polls the bound repository's daemon

## 2. Tests

- [x] 2.1 A slice test with two fixture repositories and their daemons: a `wait` with repo A, followed while it is in flight by a `status` with repo B and an event on A, returns A's events, seq and digest, and the `status` returns B's run
- [x] 2.2 A later call without `repo` is served by B, the repo the session last passed
- [x] 2.3 `npm test` green; `openspec validate operator-repo-per-call --strict` passes
