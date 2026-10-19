## ADDED Requirements

### Requirement: OpenCode e2e fixture recording
The opt-in OpenCode e2e (test/e2e/opencode.test.ts) SHALL write fixtures only under `ORCH_E2E_OPENCODE_RECORD=1`, copying each task's first launch's JSONL events to test/fixtures/opencode/e2e-<task>.jsonl (e2e-<case>-<task>.jsonl for other cases). Before writing, the recorder SHALL redact the text: every scratch path (the run directory, with and without a leading `/private`) SHALL become `<scratch>`, the home directory SHALL become `~`, the name of every git `Author:` line SHALL become `Fixture Author`, and every email address SHALL become `author@example.invalid`. A committed OpenCode fixture SHALL carry no email address other than an `example.invalid` one.

#### Scenario: A git author line is redacted
- **WHEN** a recorded event holds the output of `git show --stat HEAD` with `Author: Jane Q. Doe <jane.doe+git@mail.example.com>` and a `Co-Authored-By: Bot <noreply@anthropic.com>` trailer
- **THEN** the fixture holds `Author: Fixture Author <author@example.invalid>` and `Co-Authored-By: Bot <author@example.invalid>`, and neither the name nor either address

#### Scenario: Scratch paths and the home directory are redacted
- **WHEN** a recorded event names a path under the run directory or the home directory
- **THEN** the fixture names it under `<scratch>` or `~`

#### Scenario: Committed fixtures carry no personal address
- **WHEN** `git grep -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- test/fixtures/opencode` runs
- **THEN** every match is an `example.invalid` address
