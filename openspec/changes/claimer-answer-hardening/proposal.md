## Why

The review of GH-182 found that a claim answer without `briefPath` reaches the Claude Code worker as "The brief is the file undefined", that the MCP `claim` tool's description of `brief: false` does not fit a remote claim (whose answer has no `briefPath` and still carries `briefMarkdown`), and that host-integration "Work workflow: worker tool instructions" still says the worker prompt is composed from the brief (GH-188).

## What Changes

- `hosts/claude-code/workflows/work.js`: the worker prompt names `briefPath`, or `<worktree>/.orchestrator/brief.md` when the claim answer has none.
- `src/operator/mcp-server.ts`: the `claim` description says `brief: false` leaves out only the parsed brief, that a local answer still carries `briefPath` and a remote answer still carries `briefMarkdown`. Behaviour is unchanged.

Specs:

- host-integration: MODIFIED "Work workflow: worker tool instructions" (the prompt names the brief's path; its one scenario restated). ADDED "Work workflow: worker tool instructions: brief path fallback".
- operator-mcp: ADDED "Worker tools: brief false on a remote claim".

Unchanged, left to GH-196: the stop rule, the digest fields the claimer copies, and the run and work skills.

## Impact

- `hosts/claude-code/workflows/work.js`, `src/operator/mcp-server.ts`
- `test/host/work-loop.test.ts`, `test/slice/worker-tools.test.ts`
