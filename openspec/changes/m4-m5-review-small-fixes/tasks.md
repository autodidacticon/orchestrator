## 1. Fixture redaction

- [x] 1.1 Redact decoded strings of each JSON line in `redactFixture`; any-case email domains; names on every git identity line
- [x] 1.2 Unit tests: addresses after `\n`, `\t`, `<` and `<` leave valid JSON; `jane@X.COM`; Commit:, Committer:, Signed-off-by:, Co-Authored-By: names
- [x] 1.3 Update test/fixtures/opencode/README.md

## 2. Usage line cap

- [x] 2.1 Measure `OPENCODE_USAGE_LINE_CAP` in UTF-8 bytes in `parseOpenCodeUsage`, as `cappedLines` does
- [x] 2.2 Tests: a step_finish line of exactly the cap is counted and one byte over is skipped, string and streamed, ASCII and non-ASCII

## 3. Wording

- [x] 3.1 `orchestrator-ctl config` usage names both meanings of `--data-dir`
- [x] 3.2 The `pure: false` sentence names `runner.opencode.ignoreUserConfig` in host-integration and hosts/opencode/README.md

## 4. Launch-path test

- [x] 4.1 Slice test: a launch in a repository with an `openspec/` root gets the change-directory rule in its brief; one without does not
