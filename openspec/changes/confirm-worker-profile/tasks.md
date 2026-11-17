## 1. Daemon

- [x] 1.1 `src/config.ts`: `runner.confirmProfile`, a boolean, `false` by default
- [x] 1.2 `src/loop/orchestrator.ts`: `confirmProfile()` reads kv `runner.confirmProfile` (`on`, `off`) before the configuration
- [x] 1.3 Per-kind sources and slots of the model and effort leaves from `resolveLayers` with the stored overrides and the kind forced, memoised on the override text
- [x] 1.4 `selectionFor` and `profileOf` share one function that also says whether the model and the effort came from the payload; `missing` follows the hold, the sources, the mode in force and the slots
- [x] 1.5 `profiles()`, `profileHeld()` and `hasHeldProfile()`; `status.profiles` and `status.runner.confirmProfile`
- [x] 1.6 `src/loop/tick.ts`: the `ready` list is filtered before `admit`
- [x] 1.7 `src/operator/routes.ts`: `profileHeld` in both returns of the digest; `runner.confirmProfile` and `profiles: []` in the status body without a graph

## 2. Tests

- [x] 2.1 `test/loop/profile-hold.test.ts`: off by default, the hold, confirming, one key, per kind, capacity, unbound values and fallbacks, waiting tasks, admission only, file values, slots and modes, the stored choice, grouping
- [x] 2.2 `test/slice/profile-hold.test.ts`: the HTTP status and digest in `pull` mode, the body without a graph, a file value equal to the built-in one
