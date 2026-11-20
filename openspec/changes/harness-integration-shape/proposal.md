## Why

The three shipped kinds (Claude Code, Codex, OpenCode) are command adapters. Two more harnesses were proposed on 2026-11-20: the Antigravity CLI (`agy`) and Hermes Agent (`hermes`). The Agent Client Protocol (ACP) could be another way in: one driver, with each harness a launch command in configuration.

Three probes graded twelve criteria, fixed in advance, headless and over ACP: #197 (`opencode` 1.18.30), #198 (`agy` 1.5.13) and #199 (`hermes` 2026.9.24). This change applies one rule to their grades and names a shape per harness: (A) a command adapter, (B) an ACP driver, or none.

## What Changes

- `design.md` holds the record:
  - The criteria table, C1 to C12 against six paths: `opencode run`, `opencode acp`, `agy -p`, `agy acp`, `hermes headless` and `hermes acp`.
  - One decision per harness, with the rule applied step by step.
  - The residue of C12 for each ACP path.
  - The decisions left to the owner, the risks and the open questions.
- `tasks.md` lists this change's own tasks, and under "Later" the issues of the two later milestones: "Harness adapter and supervisor" and "Antigravity and Hermes workers".
- `README.md` "Tests" names the opt-in test that #197 added, `ORCH_E2E_ACP_OPENCODE=1 npm test -- test/e2e/acp-opencode`, and counts nine opt-in tests that use a real model.
- The result, under the rule as written: no path passes for any of the three harnesses, so each gets **none**. For OpenCode this conflicts with its shipped (A) kind, and the owner decides at the milestone review. The design lists the cell that stops each path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. The change builds nothing and changes no behaviour. Its `.openspec.yaml` sets `skip_specs: true`, so it has no `specs/` directory, and archiving it leaves `openspec/specs/` unchanged.

## Impact

- No file under `src/`, `hosts/` or `test/` changes.
- `README.md`: only the "Tests" paragraph.
- The owner decides the shape, go or no-go and the other decisions listed in `design.md` at the review of the milestone. The later milestones are planned from that answer.
