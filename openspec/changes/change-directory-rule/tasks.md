## 1. Brief

- [x] 1.1 `composeBrief` adds `OPENSPEC_CHANGE_RULE` to the Definition of done when `opts.openspec` is true, or, absent, when `<worktree>/openspec` exists
- [x] 1.2 Golden `test/fixtures/brief/claude-code-openspec.md`; the four existing goldens are unchanged

## 2. Import skills

- [x] 2.1 The Scope guidance of `hosts/claude-code`, `hosts/codex` and `hosts/opencode` import skills names `openspec/changes/<name>/**` instead of `openspec/specs/<cap>/spec.md`

## 3. Tests

- [x] 3.1 Brief tests: the rule with `openspec: true` for every kind, none with `openspec: false`, detection from a temporary worktree with and without `openspec/`
