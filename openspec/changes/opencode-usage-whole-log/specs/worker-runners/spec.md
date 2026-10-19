## MODIFIED Requirements

### Requirement: OpenCode usage parsing
`OpenCodeRunner.readUsage` SHALL read the launch log. The parser SHALL:
- read the whole log, line by line, streaming the file so memory stays bounded by the read chunk and the line cap, not the log size. OpenCode reports usage per step, not as a running total, so a step dropped from the read is usage lost; the log also carries full tool outputs and WARN-level stderr, so a tail window would drop the early steps of any task that reads large files;
- skip a line longer than 64 KiB without parsing its body: `step_finish` lines are a few hundred bytes, and the long lines are tool output;
- `JSON.parse` each line and skip lines that fail;
- for every line with `type: "step_finish"`, add `part.tokens.input + part.tokens.cache.read` to `input` (opencode's `input` excludes cache reads), `cache.read` to `cachedInput`, `cache.write` to `cacheWriteInput`, `output` to `output`, `reasoning` to `reasoningOutput`, and `part.cost` to `costUsd`.

The usage SHALL have `source: 'opencode'`, `turns` the number of `step_finish` lines with `reason: "stop"`, and no `durationMs`. A log without a `step_finish` that has input and output counts SHALL yield no usage.

#### Scenario: Probe log
- **WHEN** the log is test/fixtures/opencode/events/F1-ask.jsonl
- **THEN** the usage is `tokens { input: 14533, cachedInput: 10240, cacheWriteInput: 0, output: 25, reasoningOutput: 17 }`, `costUsd: 0`, `source: 'opencode'`

#### Scenario: Several steps
- **WHEN** the log holds several `step_finish` lines, one with `reason: "stop"`
- **THEN** each field is their sum and `turns` is 1

#### Scenario: A step before a large tool output
- **WHEN** the log holds a `step_finish` with input 1000 and cost 1, then a 300 KiB `tool_use` line, then a `step_finish` with input 5 and cost 1
- **THEN** the usage sums both steps: the input counts 1005 plus their cache reads and `costUsd` is 2

#### Scenario: Long log
- **WHEN** the log is 5 MiB with 200 `step_finish` lines between large tool outputs and stderr lines
- **THEN** each field is the exact sum of the 200 steps

#### Scenario: No step_finish
- **WHEN** the log was cut before any `step_finish`, or is a Codex log
- **THEN** no usage is read
