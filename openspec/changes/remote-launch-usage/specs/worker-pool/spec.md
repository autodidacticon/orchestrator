## ADDED Requirements

### Requirement: Usage post
The worker loop SHALL keep the last 256 KiB of the command agent's standard output, parse it with `parseUsage` once the agent process has exited, and, when the result has token counts, post `{ workerId, usage: { tokens, model, costUsd } }` once to `POST /v1/launches/:id/usage` as the last step of the launch. `model` is the claim's model when it has one; `costUsd` is `total_cost_usd` when above zero. Turns and duration are not posted.

#### Scenario: Recorded cost
- **WHEN** the agent's standard output ends with a Claude Code result object with `total_cost_usd` 0.25 and a `usage` of 100 input, 40 cache-read and 7 output tokens, and its report is accepted
- **THEN** after `report accepted` the loop posts the usage, the launch row has `usageSource: "worker"`, `costUsd` 0.25, `costSource: "reported"` and `tokens` `{ input: 140, cachedInput: 40, output: 7 }`, and the loop prints `worker <id> usage <launchId> <taskId>` once

#### Scenario: Tokens priced by the daemon
- **WHEN** the object has token counts and no `total_cost_usd` (or 0), and `budgets.prices` has the claim's model
- **THEN** the body has no `costUsd`, and the daemon prices the tokens: the row has `costSource: "priced"` and a cost above zero, which `budgets.maxRunCostUsd` counts

#### Scenario: No object
- **WHEN** the agent printed no such object, printed a line after it, printed one without `usage`, or the agent is the scripted one
- **THEN** nothing is posted and the launch has no usage

#### Scenario: Post not recorded
- **WHEN** the post is answered other than 200 with `recorded: true` (409 for a launch another worker holds, 400) or cannot be sent
- **THEN** the answer is written to stderr, no `usage` line is printed, and neither the launch's verdict nor the loop's exit code changes

#### Scenario: Terminated launch
- **WHEN** the loop gets SIGTERM while the agent runs, the agent prints its object as it stops, and the hand-back's release is answered
- **THEN** the usage is posted after that release, whatever its status, through the short retry window; when the push failed or the release got no answer nothing is posted
