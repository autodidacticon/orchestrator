## MODIFIED Requirements

### Requirement: OpenCode usage parsing
`OpenCodeRunner.readUsage` SHALL read the launch log. The parser SHALL:
- read the whole log, line by line, streaming the file so memory stays bounded by the read chunk and the line cap, not the log size. OpenCode reports usage per step, not as a running total, so a step dropped from the read is usage lost; the log also carries full tool outputs and WARN-level stderr, so a tail window would drop the early steps of any task that reads large files;
- skip a line of more than 64 KiB (65536 bytes of UTF-8) without parsing its body: `step_finish` lines are a few hundred bytes, and the long lines are tool output. The cap SHALL be measured in UTF-8 bytes both when the log is parsed from a string and when it is streamed from the file, so the two paths count the same lines;
- `JSON.parse` each line and skip lines that fail;
- for every line with `type: "step_finish"`, add `part.tokens.input + part.tokens.cache.read` to `input` (opencode's `input` excludes cache reads), `cache.read` to `cachedInput`, `cache.write` to `cacheWriteInput`, `output` to `output`, `reasoning` to `reasoningOutput`, and `part.cost` to `costUsd`.

The usage SHALL have `source: 'opencode'`, `turns` the number of `step_finish` lines with `reason: "stop"`, and no `durationMs`. A log without a `step_finish` that has input and output counts SHALL yield no usage.

#### Scenario: Probe log
- **WHEN** the log is test/fixtures/opencode/events/F1-ask.jsonl
- **THEN** the usage is `tokens { input: 14533, cachedInput: 10240, cacheWriteInput: 0, output: 25, reasoningOutput: 17 }`, `costUsd: 0`, `source: 'opencode'`

#### Scenario: Several steps
- **WHEN** the log holds several `step_finish` lines, one with `reason: "stop"`
- **THEN** each field is their sum and `turns` is 1

#### Scenario: A step before a large tool output
- **WHEN** the log holds a `step_finish` with input 1000 and cost 1, then a 300 KiB `tool_use` line, then a `step_finish` with input 5 and cost 1
- **THEN** the usage sums both steps: the input counts 1005 plus their cache reads and `costUsd` is 2

#### Scenario: Long log
- **WHEN** the log is 5 MiB with 200 `step_finish` lines between large tool outputs and stderr lines
- **THEN** each field is the exact sum of the 200 steps

#### Scenario: Line cap boundary
- **WHEN** the log holds a `step_finish` line of exactly 65536 UTF-8 bytes, or one of 65537 bytes, padded with ASCII or with multi-byte characters
- **THEN** the line of 65536 bytes is counted and the line of 65537 bytes is skipped, whether the log is parsed from a string or streamed from the file, even when the longer line has fewer than 65536 UTF-16 code units

#### Scenario: No step_finish
- **WHEN** the log was cut before any `step_finish`, or is a Codex log
- **THEN** no usage is read

### Requirement: OpenCode e2e fixture recording
The opt-in OpenCode e2e (test/e2e/opencode.test.ts) SHALL write fixtures only under `ORCH_E2E_OPENCODE_RECORD=1`, copying each task's first launch's JSONL events to test/fixtures/opencode/e2e-<task>.jsonl (e2e-<case>-<task>.jsonl for other cases). Before writing, the recorder SHALL redact each line: a line that parses as JSON SHALL be redacted on its decoded string values and keys and written back with `JSON.stringify`, so a pattern never consumes part of a JSON escape and the line stays valid JSON; any other line SHALL be redacted as text. In each string, every scratch path (the run directory, with and without a leading `/private`) SHALL become `<scratch>`, the home directory SHALL become `~`, the name on every git identity line (`Author:`, `Commit:`, `Committer:`, `Signed-off-by:`, `Co-Authored-By:` or `Co-authored-by:`, at the start of a line after optional indentation) SHALL become `Fixture Author`, and every email address, whatever the case of its domain, SHALL become `author@example.invalid`. A committed OpenCode fixture SHALL carry no email address other than an `example.invalid` one.

#### Scenario: A git author line is redacted
- **WHEN** a recorded event holds the output of `git show --stat HEAD` with `Author: Jane Q. Doe <jane.doe+git@mail.example.com>` and a `Co-Authored-By: Bot <noreply@anthropic.com>` trailer
- **THEN** the fixture holds `Author: Fixture Author <author@example.invalid>` and `Co-Authored-By: Fixture Author <author@example.invalid>`, and neither name nor either address

#### Scenario: Every identity line is redacted
- **WHEN** a recorded event holds `git show --format=fuller` output with `Commit:` and `Committer:` lines and `Signed-off-by:` and `Co-Authored-By:` trailers
- **THEN** the name on each of those lines is `Fixture Author`, and the `AuthorDate:` and `CommitDate:` lines are unchanged

#### Scenario: An address after an escape
- **WHEN** a recorded JSON line holds an address right after a `\n`, `\t`, `<` or `<` in a string, or an address with an upper-case domain such as `jane@X.COM`
- **THEN** the redacted line parses as JSON, each address is `author@example.invalid`, and the character before it is unchanged

#### Scenario: Scratch paths and the home directory are redacted
- **WHEN** a recorded event names a path under the run directory or the home directory
- **THEN** the fixture names it under `<scratch>` or `~`

#### Scenario: Committed fixtures carry no personal address
- **WHEN** `git grep -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- test/fixtures/opencode` runs
- **THEN** every match is an `example.invalid` address
