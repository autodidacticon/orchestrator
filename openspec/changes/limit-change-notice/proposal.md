## Why

Since `runtime-limit-keys` (ORC-116) the operator can change `budgets.maxLaunchMs`, `health.stuckAfterMs` and `health.stuckFailAfterMs` while launches run. A brief is written once, when the launch is prepared, so a worker that obeys its brief stops or reports before the old budget and never hears of a raise. A Codex or OpenCode `orchestrator-work` loop also ends its agent at the silence limit it took when it claimed (ORC-120).

## What Changes

- When a patch changes the value in force of any of the three limits, the daemon queues one inbox notice to each affected launch: `{ kind: 'nudge', source: 'config', message, changed, limits }`. `changed` lists the dotted names whose value in force changed; `limits` holds the three values now in force, nested like the config file. `message` gives each old and new value in milliseconds, says that 0 means off, and for the time budget gives the launch's elapsed time (gaps in the daemon's clock left out).
- Affected launches: `live` or `launching` launches that hold the lease of a `running` or `waiting` task, and every `claimable` launch (its brief was written before the change).
- The notices are queued in the transaction that writes the override document. A patch that changes no value in force of the three limits, a patch of another key, and a refused patch (400, start-only 409, `wouldEnd` 409) queue nothing. No notice kind is added: the four kinds the brief, the tools and the worker prompt name stay true.
- The work loop takes the claim's `health.stuckFailAfterMs` as its first silence limit and follows `budgets.stuckFailAfterMs` from `GET /v1/status` at every poll. `--max-silence-ms` still wins and is never replaced; a claim without `health` (a 0.5.1 daemon) keeps 45 minutes and does not read `status` for it; 0 in `status` is 45 minutes; an unreadable `status` keeps the limit the loop had. The loop logs one line when its limit changes.
- The run skills no longer tell the session to nudge a worker with the new limit, and the Codex and OpenCode editions say the loop follows the new stuck limit unless started with `--max-silence-ms`.
- The Claude Code pull workflow is unchanged: it holds no copy of the limits.

## Capabilities

### Modified Capabilities

- `agent-protocol`: ADDED "Limit change notice".
- `host-integration`: ADDED "Run skill: workers are told of a limit change"; MODIFIED "Work loop silence limit".
- `pull-runner`: MODIFIED "Silence limit in the claim".

## Impact

- `src/loop/orchestrator.ts` (`setConfig`, `limitNotices`).
- `hosts/codex/bin/work.mjs` (`silenceLimitMs`, the watcher, the usage text).
- `hosts/*/skills/run/SKILL.md` (the bullet "a launch needs more time").
- Archive note: the unarchived change `work-loop-silence-leaves-out-sleep` adds "Work loop silence leaves out a sleep", whose text says "the silence limit SHALL be chosen as before"; it holds no MODIFIED block for "Work loop silence limit", so the MODIFIED block here starts from `openspec/specs`. Read "as before" as the rule restated here.
- Archive note: the unarchived change `runtime-limit-keys` adds "Run skill offers a raised limit", which tells the agent "to tell the worker the new limit with `nudge`" and says a loop "keeps the silence limit its loop took when it claimed". "Run skill: workers are told of a limit change" here replaces those two clauses; merge them by hand at archive (drop both clauses from "Run skill offers a raised limit").
