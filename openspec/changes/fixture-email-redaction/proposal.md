## Why

`ORCH_E2E_OPENCODE_RECORD=1` (test/e2e/opencode.test.ts, ORC-63) redacted scratch paths and the home directory only. The T1 agent ran `git show --stat HEAD`, so test/fixtures/opencode/e2e-T1.jsonl line 17 carried the operator's git author line with a personal email address. The address is already public as a commit author, but the fixture has no reason to carry it, and the other OpenCode fixtures were scrubbed of personal details.

## What Changes

1. The recorder's redaction (`redactFixture` in test/e2e/opencode.test.ts) also replaces the name of every git `Author:` line by `Fixture Author` and every email address by `author@example.invalid`, after the scratch-path and home-directory replacements.
2. The committed e2e-T1.jsonl gets the same redaction; test/fixtures/opencode/README.md's Redaction section names it.
3. A unit test of `redactFixture` that runs without opencode covers an `Author:` line, a trailer address, scratch paths and the home directory.

## Capabilities

- `worker-runners`: added: "OpenCode e2e fixture recording"

## Impact

* test/e2e/opencode.test.ts
* test/fixtures/opencode/e2e-T1.jsonl, test/fixtures/opencode/README.md
