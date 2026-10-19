## 1. Recorder

- [x] 1.1 `redactFixture` in test/e2e/opencode.test.ts replaces scratch paths, the home directory, git `Author:` names and every email address; `recordFixtures` uses it
- [x] 1.2 Unit test of `redactFixture` on a JSON-escaped `git show` output with an `Author:` line and a `Co-Authored-By:` trailer, run without opencode

## 2. Fixtures

- [x] 2.1 Apply the name and email redaction to test/fixtures/opencode/e2e-T1.jsonl
- [x] 2.2 Name the redaction in the Redaction section of test/fixtures/opencode/README.md
- [x] 2.3 `git grep -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- test/fixtures/opencode` finds only example.invalid addresses
