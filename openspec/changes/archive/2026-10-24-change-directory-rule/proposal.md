## Why

All nine OPENCODE-M3 workers, and ORC-42 before them, edited `openspec/specs/*/spec.md` directly and wrote no `openspec/changes/<name>/` directory, so the archive entries had to be reconstructed after the fact (e9fe424..d1f5a8f). The issues' Scope listed `openspec/specs/<cap>/spec.md`, which invited direct edits, and nothing in the brief said how spec changes are recorded. Direct edits lose the per-change proposal and design record, make two concurrent tasks touching one capability collide on the main spec file, and skip `openspec validate <change>` (ORC-74).

## What Changes

- In a repository with an `openspec/` root (detected as `<worktree>/openspec`), the brief's Definition of done says to record spec changes as an OpenSpec change directory named after the task (proposal.md, tasks.md, `specs/<cap>/spec.md` deltas), validated with `openspec validate <name>`, and not to edit `openspec/specs` directly. Without the root the brief is unchanged.
- A new golden `test/fixtures/brief/claude-code-openspec.md`; the existing goldens are unchanged.
- The import skills of the three hosts tell the agent that Scope lists `openspec/changes/<name>/**`, not `openspec/specs/<cap>/spec.md`.
- Not in this change: the verifier refusing a submission that edits `openspec/specs` (the optional item 3 of ORC-74).

## Capabilities

### New Capabilities

### Modified Capabilities

- `agent-protocol`: "Standalone brief" adds the change-directory item to the definition of done when the repository has an `openspec/` root.
- `host-integration`: adds "Import skill scope guidance for OpenSpec".

## Impact

- `src/brief/compose.ts` (`ComposeOptions.openspec`, `OPENSPEC_CHANGE_RULE`), `test/loop/brief.test.ts`, `test/fixtures/brief/claude-code-openspec.md`, `hosts/*/skills/import/SKILL.md`.
