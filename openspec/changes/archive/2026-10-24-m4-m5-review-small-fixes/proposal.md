## Why

The CODEX-M5/OPENCODE-M4 review (2026-10-24, ORC-82) found five small defects:

1. The e2e fixture recorder ran its email pattern on JSON-escaped text, so an address right after `\n`, `\t` or `<` lost the escape's letter and the line stopped being valid JSON. The pattern matched only lower-case top-level domains, and only `Author:` lines had their names replaced.
2. The OpenCode usage parser measured its 64 KiB line cap in UTF-16 code units on the string path and in bytes on the streamed path, so the two disagreed on long non-ASCII lines, and no test exercised the cap.
3. The `orchestrator-ctl config` usage stated only the `--data-dir <shared|launch>` meaning of the flag.
4. The "OpenCode host" requirement and hosts/opencode/README.md said a `pure: false` worker loads every installed plugin, ignoring `runner.opencode.ignoreUserConfig`.
5. ORC-74's OpenSpec change-directory rule was tested only through `composeBrief`, not through a real launch.

## What Changes

- The recorder redacts each JSON line's decoded strings and re-encodes the line; the email pattern takes any case of domain; the names on `Author:`, `Commit:`, `Committer:`, `Signed-off-by:` and `Co-Authored-By:` lines become `Fixture Author`.
- The usage line cap is 64 KiB of UTF-8 bytes on both paths, tested at the exact boundary with ASCII and non-ASCII lines.
- The config usage names both meanings of `--data-dir`.
- The `pure: false` sentence names `ignoreUserConfig`, in the spec and the README.
- A slice test checks the change-directory rule in the brief of a real launch, with and without an `openspec/` root.

## Capabilities

### Modified Capabilities
- `worker-runners`: "OpenCode usage parsing" (cap in bytes on both paths), "OpenCode e2e fixture recording" (decoded redaction, every identity line, any-case domains).
- `host-integration`: "OpenCode host" (`pure: false` and `ignoreUserConfig`).

## Impact

test/e2e/opencode.test.ts, test/fixtures/opencode/README.md, src/runner/opencode.ts, test/health/usage.test.ts, src/operator/cli.ts, hosts/opencode/README.md, test/slice/launch.test.ts. Committed fixtures are not re-recorded.
