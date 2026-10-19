## 1. Implementation

- [x] 1.1 `openCodePermission('derived', rules)`: every catch-all becomes `deny` (top-level `"*"` and bash `"*"`); allow `write` (and `patch` if 1.18.30 has it; check the schema in test/fixtures/opencode or `opencode debug config`) beside the file tools; add the check command's own pattern; decide and document how chained commands (`a && b`, `a; b`, pipes) are matched by OpenCode 1.18.30, probing it, and derive rules that let the commands the brief asks for run (git add/commit chains, the check command). `allow` is unchanged.
- [x] 1.2 Brief: the OpenCode paragraph quotes the deny error ("The user has specified a rule which prevents you…") and keeps the instruction to ask with `needsAccess`; regenerate the two OpenCode goldens; the claude-code and codex goldens stay byte-identical.
- [x] 1.3 Classifier: a deny refusal that the agent continued past is not a failure; `permissionDenied` still names an ask auto-reject (a run configured with `ask` by an operator override), and the classifier tests cover both shapes from the new fixtures.
- [x] 1.4 Un-skip ORC-63's needsAccess case and make it pass: a task whose brief needs a command outside the patterns raises a `needsAccess` question naming the command, the test answers it, the task finishes.
- [x] 1.5 Specs: worker-runners states the derived ruleset's tool list, the deny catch-all and why (ask ends the run headless), and the chained-command rule; task-lifecycle "Health failure reasons" corrects the permissionDenied fact; agent-protocol's brief requirement quotes the deny message.

## 2. Record

- [x] 2.1 Spec edits landed in 7cb65ab; change directory reconstructed at archive time
