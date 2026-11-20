## 1. Workflow

- [x] 1.1 The worker prompt names `briefPath`, or `<worktree>/.orchestrator/brief.md` when the claim answer has no `briefPath`

## 2. MCP tool

- [x] 2.1 The `claim` description says `brief: false` leaves out only the parsed brief and that a remote answer still carries `briefMarkdown`

## 3. Tests

- [x] 3.1 A stub run of `work.js` with a claim answer without `briefPath` in `test/host/work-loop.test.ts`; the description text in `test/slice/worker-tools.test.ts`
- [x] 3.2 `openspec validate claimer-answer-hardening --strict`, and archive in a copy of `openspec/` followed by `openspec validate --specs --strict`
