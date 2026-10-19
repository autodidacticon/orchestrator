## 1. Slice

- [x] 1.1 test/slice/launch.test.ts: an opencode `submitDirty` launch under `runner.opencode.commit: daemon` through `OpenCodeRunner` with a fake `opencode` on PATH reaches `done` with the orchestrator's commit on the launch branch and `committedByOrchestrator: true`

## 2. E2E counter rule

- [x] 2.1 test/e2e/opencode.test.ts: `checkContended` asserts `charged: false` for each task's first `health.contendedRetries` startupContended deaths and `charged: true` after, and counts attempts from the allowance
- [x] 2.2 Unit tests of `checkContended`, run without opencode, for a passing sequence, a charged death within the allowance, and an uncharged death past it
- [x] 2.3 Flipping one death within the allowance to `charged: true` in the passing case fails the test (checked locally, then reverted)

## 3. Skill edition guard

- [x] 3.1 test/host/opencode-host.test.ts: each rewritten block pinned to a sha256 prefix keyed by its anchor
- [x] 3.2 Changing a word inside a rewritten block of hosts/opencode/skills/run/SKILL.md fails the host test (checked locally, then reverted)
