## Why

The default permission mode cannot finish a task, and the needsAccess path the brief promises does not exist. The OPENCODE-M3 claim (a capacity-2 run publishing every task under the defaults) cannot hold until this lands.

## What Changes

1. `openCodePermission('derived', rules)`: every catch-all becomes `deny` (top-level `"*"` and bash `"*"`); allow `write` (and `patch` if 1.18.30 has it; check the schema in test/fixtures/opencode or `opencode debug config`) beside the file tools; add the check command's own pattern; decide and document how chained commands (`a && b`, `a; b`, pipes) are matched by OpenCode 1.18.30, probing it, and derive rules that let the commands the brief asks for run (git add/commit chains, the check command). `allow` is unchanged.
2. Brief: the OpenCode paragraph quotes the deny error ("The user has specified a rule which prevents you…") and keeps the instruction to ask with `needsAccess`; regenerate the two OpenCode goldens; the claude-code and codex goldens stay byte-identical.
3. Classifier: a deny refusal that the agent continued past is not a failure; `permissionDenied` still names an ask auto-reject (a run configured with `ask` by an operator override), and the classifier tests cover both shapes from the new fixtures.
4. Un-skip ORC-63's needsAccess case and make it pass: a task whose brief needs a command outside the patterns raises a `needsAccess` question naming the command, the test answers it, the task finishes.
5. Specs: worker-runners states the derived ruleset's tool list, the deny catch-all and why (ask ends the run headless), and the chained-command rule; task-lifecycle "Health failure reasons" corrects the permissionDenied fact; agent-protocol's brief requirement quotes the deny message.

## Capabilities

- `agent-protocol`: modified: "Standalone brief", "Check command and tool rules in the brief"
- `task-lifecycle`: modified: "Health failure reasons"
- `worker-runners`: modified: "OpenCode runner command composition"

## Impact

* src/runner/opencode.ts, src/brief/compose.ts
* test/runner/opencode.test.ts, test/loop/brief.test.ts, test/fixtures/brief/opencode-*.md, test/fixtures/opencode/** (new probe outputs and README lines only), test/e2e/opencode.test.ts, test/e2e/opencode-work.test.ts

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-65 edited `openspec/specs` directly in commit 7cb65ab instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-65 issue text.

Commit summary: The OpenCode derived ruleset can now finish a real launch (commit b847d6c). openCodePermission('derived', rules, checkCommand?) has no ask anywhere. Its catch-alls ('*' and bash '*') are deny. It allows write beside read/glob/grep/list/edit, plus `git *`, the derived patterns, and one exact pattern per command of the check command (new export checkCommandPatterns, which splits at &&, ||, ;, | and newlines outside quotes). openCodeConfig gains a 5th parameter, checkCommand. OpenCodeRunner.spawn reads it from the launch's .orchestrator/brief.json (new export briefCheckCommand), and the work loop passes the claim's brief.checkCommand. The chained-command rule of 1.18.30 was probed and is recorded in test/fixtures/opencode/events/X-*.jsonl with configs/X-*.json: each command of an &&, ; or | chain is matched on its own, a whole-chain pattern never matches, a redirect is not a separate command, and cd is exempt. The brief's OpenCode paragraph quotes the deny error and lists write and the check-command patterns; it says every other command is denied and states the chain rule. The two OpenCode goldens were regenerated. Classifier tests cover P-ask (permissionDenied) and four deny-and-continue fixtures (undefined); no classifier code change was needed beyond the doc comment. The needsAccess e2e case is un-skipped and passes. The work e2e defaults to derived and answers questions. worker-runners, task-lifecycle and agent-protocol specs are updated, and the fixtures README has a chained-commands section.
