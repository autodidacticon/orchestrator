## Why

The Claude Code worker workflow (`hosts/claude-code/workflows/work.js`) starts a cheap claimer agent before every worker. The M5 Verifier pool run showed four problems with it (GH-182): the claimer's copy of the brief was not always exact and cost 12,000 to 20,000 output tokens per claim; the stop decision rested on a sentence the model had to evaluate; idle polling read the full `status` three times per claimer; and a claimer that returned nothing ended its loop without a word. The claim answer also carried the parsed brief, which put a large brief's answer over the tool-output limit.

## What Changes

- The claimer claims with `brief: false` and returns `briefPath`; it never reads the brief, and its schema has no `briefMarkdown`. The worker prompt names `briefPath` and tells the worker to read the whole file before anything else.
- The claimer reads the `wait` digest and never calls `status`. It returns `finished`, `stalled`, `claimable`, `preparing`, `verifying`, `openQuestions` and `awaitingReview`, and returns before its third poll only on `finished` or `stalled`. `stop` leaves its schema.
- The script decides when a loop stops with `stopRule(d, othersHold)`, today's rule in code.
- A claimer that returns nothing is retried once; a second ends the loop, each with a log line. A claimer that answers `error` ends its loop with a log line.
- The MCP `claim` tool gains an optional `brief`; with `false` it drops `brief` from the daemon's answer. The daemon's route is unchanged.
- The work skill says the claimer reads the `wait` digest.

Specs:

- host-integration: MODIFIED "Work workflow: claimer agent", "Work workflow: worker agent", "Work workflow: claims only claude-code launches", "Work workflow: loop end" (its scenario said "the claimer's stop is false"), and "Work skill and workflow" (all 11 scenarios restated; "Idle loop polls inside one claimer" and "A launch being prepared keeps the claimer polling" changed). ADDED "Work workflow: claimer agent: digest fields", "Work workflow: claimer agent: stop rule in the script" and "Work workflow: claimer agent: a silent claimer".
- operator-mcp: MODIFIED "Worker tools" (all 4 scenarios restated, one added for `brief: false`).

Unchanged: three polls of up to 90 s per claimer, the claimer's model and effort, `leaseRule` and the worker's tool instructions, and the 200-cycle cap.

## Impact

- `hosts/claude-code/workflows/work.js`, `hosts/claude-code/skills/work/SKILL.md`
- `src/operator/mcp-server.ts` (`claim` tool)
- `test/host/work-loop.test.ts`, `test/slice/worker-tools.test.ts`
