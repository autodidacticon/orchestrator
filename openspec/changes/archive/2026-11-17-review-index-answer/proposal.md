## Why

`review` returned one answer that grew with the milestone and could only be read whole. At review versions 2, 3 and 4 of one 24-task milestone it was about 117,000, 122,000 and 154,000 characters. At version 4, evidence was about 54 percent, the diff stat 25 percent (614 file lines) and the summaries 19 percent. A client that caps a tool result could not read it, and a reviewer had to page through every task's evidence to find one (ORC-111).

## What Changes

- The default answer of `GET /v1/milestones/<id>/review` is an index (`view: "index"`): the pinned sha, version, tag, baseline and milestone criteria as before, the diff stat cut to `statLines` file lines plus a ` ... <k> more files` line and git's totals line, and per closure task its title, status, published sha, summary cut to `summaryChars` UTF-16 units, `summaryLength`, `acceptanceCount` and `changedFileCount`. `omitted` lists each cut with its count and how to fetch what was left out.
- `?task=<id>` answers one closure task (`view: "task"`): its own acceptance criteria, its changed files and every field of its latest submit report except proposals. It reads the store only and makes no git call.
- `?full=true` answers the whole bundle as before, with `view: "full"` and `omitted: []`.
- Config keys `review.statLines` (default 40) and `review.summaryChars` (default 400), read at daemon start; request parameters `statLines` and `summaryChars` override them for one call. They are not runtime-changeable.
- Bad parameters are answered 400 with the parameter's name; a task outside the closure 404 with the closure's task ids.
- The `review` MCP tool takes `task`, `full`, `statLines` and `summaryChars` and forwards the ones that are set (`full` only when true). The tool count stays 31.
- `orchestrator-ctl review <milestone> [--task <id>] [--full] [--stat-lines <n>] [--summary-chars <n>]`.

## Capabilities

### New Capabilities

### Modified Capabilities
- `operator-control`: MODIFIED "Review bundle".
- `operator-mcp`: MODIFIED "Review tool".

## Impact

- `src/operator/review.ts` (new), `src/operator/routes.ts`, `src/operator/mcp-server.ts`, `src/operator/cli.ts`, `src/config.ts`. `Orchestrator.reviewBundle` is unchanged and still builds the whole bundle.
- Tests: `test/operator/review.test.ts` (new), `test/slice/events.test.ts`, `test/slice/operator-mcp.test.ts`, `test/slice/operator.test.ts`.
- The review skills under `hosts/` still describe the whole bundle; a later task rewrites them. `README.md` lists the command and keys in a later task.
- Path ids are matched against the undecoded `url.pathname` (`src/agent/server.ts`), so a milestone id that needs percent-encoding is not reachable by path, as for every other path route. The task id travels in the query and is decoded.
