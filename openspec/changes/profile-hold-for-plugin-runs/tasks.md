## 1. Daemon and lifecycle

- [x] 1.1 `src/main.ts`: `--default-confirm-profile on|off`, checked right after the help branch; the stored choice written from the file at every start, else from the flag when the store has none; the flag in `USAGE`
- [x] 1.2 `src/runs/lifecycle.ts`: `StartOptions.defaultConfirmProfile`, passed only to a spawned daemon and independent of `--mode`; `StartResult.confirmProfile` from the status probe in both paths, the probe made on a running daemon also when a `mode` is passed

## 2. Operator server

- [x] 2.1 `src/operator/mcp-server.ts`: `defaultConfirmProfile: true` in the `start` tool and the local revival in `url()`; the remote path unchanged
- [x] 2.2 The `claude` object in the `start` and `configure` input schemas
- [x] 2.3 The `start`, `status` and `wait` descriptions

## 3. Skills

- [x] 3.1 Run skills: the **Worker profile.** paragraph and the `profileHeld` monitor bullet (Claude Code, Codex, OpenCode)
- [x] 3.2 Import skills: the **Worker profile.** bullet and the **Held tasks.** paragraph
- [x] 3.3 Claude Code work skill: the **Worker profile.** bullet

## 4. Tests

- [x] 4.1 `test/runs/lifecycle.test.ts`: the default adopted once and durable, the file overwriting the stored choice, the bad flag value and `USAGE`
- [x] 4.2 `test/slice/operator-mcp.test.ts`: the hold through `start`, `status`, `wait` and `configure`; the `claude` object; the revival; the descriptions and the `configure` property list
- [x] 4.3 The two `pull` tests get `runner: { confirmProfile: false }` in their file
- [x] 4.4 Host tests cut out and check the new skill blocks
- [x] 4.5 `test/e2e/codex-operator.test.ts`: the prompt passes the model and effort to `start` (opt-in, not run here)
