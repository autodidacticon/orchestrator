## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Ten of the 15 requirements of `health-monitoring` are over the limit. This change, part 1 of 2, handles five of them: "Process liveness" (1429 characters), "Progress signals" (2144), "Stuck detection and escalation" (919), "Launch time budget" (537) and "Usage accounting" (4997). It splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (#139, task GH-172). Part 2 (`openspec-2-health-monitoring-2`) splits the other five long requirements; the two parts touch disjoint requirements.

## What Changes

- MODIFIED, five requirements: "Process liveness", "Progress signals", "Stuck detection and escalation", "Launch time budget" and "Usage accounting". Each keeps its header and every scenario, names and texts unchanged; its description is cut to one behavior of at most 500 characters (492, 426, 465, 261 and 290).
- ADDED, 25 requirements, one per behavior removed from a MODIFIED description. Each is named after the requirement its text comes from, then a colon and the behavior it holds. Each holds the moved sentences, unchanged or with only their references made explicit, has a description of at most 500 characters with SHALL, and has one or two new scenarios with WHEN and THEN.
- No sentence of the originals is over 500 characters on its own (the longest is 417), so none is split at a semicolon, a list item or a clause joint, and no SHALL is added at a joint.
- No SHALL or MUST is dropped: the five original descriptions hold 71; the cut descriptions hold 14 and the ADDED descriptions 57, 71 in all. Nothing is removed or renamed, and no other requirement changes.

### Lists and lead-ins

- "Usage accounting" has a list of four runner bullets under the lead-in "Each runner SHALL read its own log format:". Every bullet carries a SHALL of its own, so no bullet is given a lead-in. The list is split between its items: the lead-in stays with the Claude Code bullet in "Usage accounting: Claude Code log", and the Codex, OpenCode and scripted bullets each move, word for word without the list marker "- ", into "Usage accounting: Codex log", "Usage accounting: OpenCode log" and "Usage accounting: scripted and in-process runners".
- The Claude Code bullet is three sentences long (593 characters with its lead-in). Its first sentence stays under the lead-in in "Usage accounting: Claude Code log"; its second and third, about how the object is found, move to "Usage accounting: Claude result object search" with their references made explicit.
- The pricing list (the sentence "A usage with tokens and no cost SHALL be priced ... rounded to 1e-6:" and its five bullets) moves whole, with its list markers, to "Usage accounting: pricing tokens without a cost" (423 characters).
- The two sentences "The pricing rests on two assumptions, both unverified: Codex's `cached_input_tokens` is ..." carry no SHALL of their own. Kept with the pricing list they would make 606 characters, so they move to "Usage accounting: Codex log", whose SHALL sentence about Codex usage carries them within 500 characters (381), with "The pricing" made explicit. No lead-in and no SHALL is added for them.
- No other lead-in is added.

### Moved sentences

Sentences are numbered from 1 in each original description; a bullet counts as one sentence, and a sentence that holds a colon followed by a list or clause counts as one. *Unchanged* means word for word. *Explicit* means only a reference was made explicit, naming the replaced words. Every sentence not listed stays word for word in its MODIFIED description.

#### Process liveness

Stays: sentences 1 ("On every tick, in the reconcile phase, ..."), 2 ("`alive` SHALL renew ..."), 3 ("`dead` SHALL be handled as before: ...") and 10 ("A dead launch's diagnosis also decides whether its failure is charged: ...").

- 4, unchanged: "When the runner implements `readFailure` and returns a diagnosis `{ reason, detail? }` for the dead launch, the dead-launch record SHALL carry it: ..." → "Process liveness: runner diagnosis of a dead launch"
- 5, unchanged: "A runner without `readFailure`, or one that returns nothing, SHALL leave the record as before." → "Process liveness: runner diagnosis of a dead launch"
- 6, unchanged: "The same SHALL hold for a launch found dead at recovery." → "Process liveness: runner diagnosis of a dead launch" (it follows the sentences it refers to, as in the original)
- 7, unchanged: "`unknown` SHALL leave lease expiry as the only bound on silence." → "Process liveness: liveness by runner"
- 8, unchanged: "Runners that spawn processes SHALL derive liveness from the recorded pid; a runner that cannot observe its launches SHALL report `unknown`." → "Process liveness: liveness by runner"
- 9, unchanged: "For the OpenCode runner the recorded pid leads the `sh` process group that holds `opencode` and its MCP child (the shim): ..." → "Process liveness: liveness by runner"

#### Progress signals

Stays: sentences 1 ("For every live launch whose task is `running` and whose process is alive, the daemon SHALL compute a progress fingerprint each tick: ...") and 2 ("A touch that leaves a tracked file's content unchanged SHALL NOT change the fingerprint.").

- 3, explicit ("the fingerprint changes" → "the progress fingerprint changes"): "The daemon SHALL record `progressAt` and `lastSignal` on the launch row when the fingerprint changes ..." → "Progress signals: recorded signals"
- 4, unchanged: "A launch SHALL start with `progressAt` equal to `spawnedAt`, and its first fingerprint SHALL be a baseline that does not count as progress." → "Progress signals: baseline at spawn"
- 5, unchanged: "A remote launch (`access: remote`) has no worktree on the daemon's host: the daemon SHALL NOT compute its fingerprint ..." → "Progress signals: remote launch fingerprint source"
- 6, explicit ("computed as above" → "computed as the daemon computes a progress fingerprint"): "A heartbeat body MAY carry `fingerprint`, the clone's fingerprint computed as above (the head sha, a colon, the hash)." → "Progress signals: remote launch fingerprint source"
- 7, unchanged: "For a remote launch a malformed `fingerprint` SHALL be answered 400 naming the field before anything is written; a well-formed one SHALL be compared ..." → "Progress signals: remote heartbeat fingerprint check"
- 8, unchanged: "A remote heartbeat that carries `fingerprint` SHALL count as progress only through its fingerprint or a new `progress` text, ..." → "Progress signals: remote heartbeat counting"
- 9, unchanged: "For a local launch a heartbeat's `fingerprint` SHALL be ignored." → "Progress signals: remote heartbeat counting"

#### Stuck detection and escalation

Stays: sentences 1 ("Config `health.stuckAfterMs` ... SHALL each be disabled when 0."), 3 ("When a `running` task's launch has been idle for longer than `stuckAfterMs`, the daemon SHALL flag it: ...") and 4 ("New progress SHALL clear the flag and append `launch.unstuck`.").

- 2, unchanged: "A launch's idle time SHALL be the awake time (see "Gap in the daemon's clock") from `progressAt` (or `spawnedAt`, or the launch's creation) to now." → "Stuck detection and escalation: idle time"
- 5, unchanged: "When idleness exceeds `stuckFailAfterMs`, the daemon SHALL reap the process, end the launch, and transition the task `running -> failed` with reason `stuck`, increasing `attempts`." → "Stuck detection and escalation: failure"
- 6, unchanged: "A `waiting` task SHALL never be flagged or failed as stuck." → "Stuck detection and escalation: failure"
- 7, unchanged: "Status and the digest SHALL list flagged task ids under `stuck`." → "Stuck detection and escalation: status listing"

#### Launch time budget

Stays: sentences 1 ("Config `budgets.maxLaunchMs` (default two hours) SHALL be disabled when 0.") and 3 ("When a `running` task's launch exceeds the budget, the daemon SHALL reap the process, ...").

- 2, unchanged: "`elapsedMs` for a launch SHALL be the awake time (see "Gap in the daemon's clock") since `spawnedAt` (or the launch's creation), excluding time its task spent `waiting`: ..." → "Launch time budget: elapsed time"

#### Usage accounting

Stays: sentences 1 ("Usage SHALL have two sources, ..."), 2 ("When a spawned launch is observed dead or is ended, the daemon SHALL ask the runner named on the launch row for the launch's usage.") and 8 ("A log without usage SHALL yield no usage.").

- 3, unchanged (the list's lead-in): "Each runner SHALL read its own log format:" → "Usage accounting: Claude Code log"
- 4, unchanged (Claude Code bullet, first sentence): "- The Claude Code runner SHALL parse the last JSON object in the launch log for `total_cost_usd`, ..." → "Usage accounting: Claude Code log"
- 4, explicit (Claude Code bullet, second sentence; "It SHALL find that object" → "The Claude Code runner SHALL find the last JSON object in the launch log"): "It SHALL find that object whatever it holds when it starts a line within the last 256 KiB of the log: ..." → "Usage accounting: Claude result object search"
- 4, explicit (Claude Code bullet, third sentence; "The object" → "The last JSON object in the launch log"): "The object SHALL run to the end of the log; an object followed by another line SHALL yield no usage." → "Usage accounting: Claude result object search"
- 5, unchanged without its list marker (Codex bullet): "The Codex runner SHALL sum the `usage` of every `turn.completed` line, ..." → "Usage accounting: Codex log"
- 6, unchanged without its list marker (OpenCode bullet): "The OpenCode runner SHALL sum every `step_finish` line, ..." → "Usage accounting: OpenCode log"
- 7, unchanged without its list marker (scripted bullet): "The scripted and in-process runners SHALL yield no usage unless scripted." → "Usage accounting: scripted and in-process runners"
- 9, unchanged: "A claimed launch has no pid and no log, so it SHALL yield no runner usage, and the daemon SHALL NOT ask the runner for it." → "Usage accounting: claimed launch usage"
- 10, explicit ("Its usage" → "The claimed launch's usage"): "Its usage SHALL come only from its worker through `POST /v1/launches/:id/usage` ..." → "Usage accounting: claimed launch usage"
- 11, unchanged: "Because launches with a pid are refused there, the two sources never apply to the same launch." → "Usage accounting: claimed launch usage"
- 12, unchanged: "Self-reported usage is not authoritative." → "Usage accounting: claimed launch usage"
- 13, unchanged: "Usage SHALL carry `tokens` as `{ input, cachedInput?, cacheWriteInput?, output, reasoningOutput? }` ..." → "Usage accounting: token shape"
- 14, unchanged: "`cachedInput` is counted inside `input`, so Claude's cache reads are added to its `input_tokens`, ..." → "Usage accounting: token shape"
- 15, unchanged: "The sources are `claude-code`, `codex`, `opencode`, `scripted`, and `worker`." → "Usage accounting: token shape"
- 16, unchanged: "A usage with any of a cost, turns, a duration, or tokens SHALL be recorded, so a usage with only tokens is recorded." → "Usage accounting: stored usage"
- 17, unchanged with its five bullets: "A usage with tokens and no cost SHALL be priced as "Run cost budget" states, per million tokens and rounded to 1e-6:" → "Usage accounting: pricing tokens without a cost"
- 18, explicit ("The pricing" → "The pricing of a usage with tokens and no cost"): "The pricing rests on two assumptions, both unverified: Codex's `cached_input_tokens` is a subset of `input_tokens`, and `reasoning_output_tokens` is NOT included in `output_tokens`." → "Usage accounting: Codex log"
- 19, unchanged: "Usage found SHALL be stored on the launch row as `costUsd`, `turns`, `durationMs`, `tokens`, `usageSource`, and `costSource` ..." → "Usage accounting: stored usage"
- 20, unchanged: "`durationMs` SHALL stay unset when the runner reports none; `status.liveLaunches[].elapsedMs` gives wall time." → "Usage accounting: stored usage"
- 21, unchanged: "The cost and tokens of a task SHALL be the sums over its launches, and those of the run the sums over all launches." → "Usage accounting: task and run sums"
- 22, explicit ("All of them" → "All of these costs and tokens"): "All of them SHALL be derived from launch rows, so that a restart cannot double count." → "Usage accounting: task and run sums"
- 23, unchanged: "A headless agent writes its usage only when it exits." → "Usage accounting: report grace"
- 24, unchanged: "The daemon SHALL therefore record `reportedAt` on the launch when a submit is accepted." → "Usage accounting: report grace"
- 25, explicit ("It SHALL leave" → "The daemon SHALL leave"): "It SHALL leave a live launch whose task is `submitted` or `done` running while its process is alive and the report is younger than `health.reportGraceMs` ..." → "Usage accounting: report grace"
- 26, unchanged: "`health.reportGraceMs` SHALL be a config-file key read at start and SHALL NOT be a runtime override." → "Usage accounting: report grace"
- 27, explicit ("the process" → "a reported launch's process", "the grace" → "the report grace"): "When the process exits or the grace elapses, the daemon SHALL reap what remains, ..." → "Usage accounting: end after the grace"
- 28, unchanged: "A process that does not exit after its report SHALL be reaped, and its launch ended, on the first tick at or after `health.reportGraceMs` from the report." → "Usage accounting: end after the grace"
- 29, unchanged: "A reap SHALL send SIGTERM to the launch's process group and wait until the group is empty, ..." → "Usage accounting: reap waits for the process group"
- 30, unchanged: "So a usage line the agent writes while it is terminated is read." → "Usage accounting: reap waits for the process group"
- 31, unchanged: "A pid that leads no group SHALL be waited for alone." → "Usage accounting: reap waits for the process group"
- 32, explicit ("these grace mechanics" → "the report grace mechanics"): "Token accounting does not change these grace mechanics: in every observed run, Codex wrote `turn.completed` with its usage after its final `agent_message`." → "Usage accounting: launches outside the report grace"
- 33, unchanged: "Cancelled and superseded launches SHALL be reaped at once as before." → "Usage accounting: launches outside the report grace"
- 34, explicit ("the grace" → "the report grace"): "A lingering launch delays the idle exit by at most the grace." → "Usage accounting: launches outside the report grace"

### Where each new scenario comes from

At the base commit 941ee02:

- "Runner without readFailure": `test/loop/health.test.ts` ("a runner without readFailure fails a dead launch as before").
- "Dead at recovery with the runner's reason": `test/health/contended.test.ts` ("any other death at restart is recorded charged and fails as before": `launch.failed` payload `{ reason: 'exitBeforeTurn', charged: true }`; the `dieAtRestart` helper kills the launch with no fallback file in the fake workspace; `recovered-dead` is asserted in "a startupContended death is recorded uncharged ..."), and `src/launch/recovery.ts` (the dead branch takes `runnerFailure` from `exitedWithoutReport` and passes it to `endLaunch(launch, 'recovered-dead', { runnerFailure })`).
- "Unknown liveness is bounded by the lease alone": `test/loop/health.test.ts` ("a silent but alive agent keeps its lease past the TTL; unknown liveness still expires it").
- "Any API call is progress": `test/loop/health.test.ts` ("first fingerprint is a baseline; worktree change, commit, API calls, and new heartbeat text are progress": the repeated "reading code" heartbeat and the `log` call).
- "First fingerprint is a baseline": `test/loop/health.test.ts` (same test: `lastSignal` `spawned` and `progressAt` `spawnedAt` after the spawn, and `lastSignal` `spawned` with the stored fingerprint after the baseline tick).
- "Remote launch without fingerprint heartbeats": `test/health/progress.test.ts` ("reconcile of a live remote launch calls Workspace.fingerprint zero times; ...": `fingerprint` undefined and the task `running` after three ticks).
- "Malformed remote fingerprint": `test/health/progress.test.ts` ("a remote heartbeat with a new fingerprint records commit ...": 400 with `field` `fingerprint`, stored fingerprint unchanged), and `src/loop/orchestrator.ts` (the `FINGERPRINT_PATTERN` check answers 400 naming `fingerprint`).
- "Unchanged remote fingerprint renews the lease only": `test/health/progress.test.ts` (same test: the repeated fingerprint keeps `progressAt` and `lastSignal`, and the lease `expiresAt` is now plus the 60000 ms TTL).
- "Idle time since the spawn": `test/loop/health.test.ts` ("flags, nudges through the inbox, then fails ...": `launch.stuck` with `idleMs` 1500 and `lastSignal` `spawned`, and the live launch's `idleMs` 1500).
- "Stuck failure ends the launch": `test/loop/health.test.ts` (same test: process gone, `endReason` `stuck`, `attempts` 1, `priorFailure` `stuck`, trigger `stuck`).
- "Flagged tasks listed": `test/loop/health.test.ts` (same test: `status().stuck` is `['T1', 'T5']`, T1's live launch has `stuck: true`, and `status().stuck` is empty after both make progress).
- "A resume grows waitedMs": `test/loop/health.test.ts` ("resume records progress and excludes the wait from the launch clock").
- "Last object after earlier objects": `test/health/usage.test.ts` ("reads the last JSON object of a Claude Code log, after stderr noise and earlier objects").
- "Text after the result object": `test/health/claude-result-line.test.ts` ("yields nothing when a line of text follows the object", "yields nothing for 300 lines of {} without usage").
- "Codex turns summed": `test/health/usage.test.ts` ("sums two turn.completed lines"; "sums turn.completed usage from a JSONL log with stderr lines interleaved" shows no `costUsd`, `durationMs` or `turns`).
- "Reasoning output priced on top of output": `test/health/budgets.test.ts` ("bills reasoning output on top of output at its own rate, falling back to the output rate").
- "OpenCode steps summed": `test/health/usage.test.ts` ("sums every step of SA-proj2.jsonl and counts the reason "stop" steps as turns").
- "No usage unless scripted": `src/runner/inproc.ts` (`readUsage` returns the usage scripted for the launch id, else for the task id, else nothing), `test/loop/health.test.ts` (`usageScript` set by task id, e.g. "usage is read when a launch ends ..."); the scripted agents run under `SubprocessRunner` (`src/runner/subprocess.ts`), which has no `readUsage`.
- "Worker usage for a spawned launch is refused": `test/loop/health.test.ts` ("a claimed launch ends with no usage, its worker posts it once, and a spawned launch still reads its runner": the post for `l5` is 409, no `launch.usage`, and T5 ends with its runner's cost).
- "Claude cache fields in the shared shape": `test/health/usage.test.ts` ("lifts the cache fields into the runner-neutral token shape, cache reads counted inside input").
- "Usage stored on the launch row": `test/loop/health.test.ts` ("usage is read when a launch ends, summed per task and per run, and derived from rows after a restart").
- "Cached input priced apart": `test/health/budgets.test.ts` ("bills input minus cached input at the input rate and cached input at its own rate, falling back to the input rate").
- "Run cost summed from launch rows": `test/loop/health.test.ts` ("usage is read when a launch ends, summed per task and per run, ...").
- "Reported launch left running": `test/loop/health.test.ts` ("a submitted launch is left alive for the report grace, ...": `status` `live` with `reportedAt`, process alive, no `launch.usage`).
- "Grace refused at runtime": `test/loop/config.test.ts` ("refuses bad limit values with 400 naming the dotted key, and applies nothing": `setConfig({ health: { reportGraceMs: 1 } })` is 400 with `key` `health.reportGraceMs`).
- "Exit and linger under one grace": `test/loop/health.test.ts` ("a submitted launch is left alive for the report grace, ...": T1 ends `reported` with cost 1.5 after its exit; T5 is reaped and ended `reported` 31 s on).
- "Group member that ignores SIGTERM": `test/runner/kill-tree.test.ts` ("kills a child that ignores SIGTERM after the grace and leaves no process of the group"), `src/runner/subprocess.ts` (`killTree`).
- "Cancelled launch reaped at once": `test/loop/health.test.ts` ("a submitted launch is left alive for the report grace, ...": the cancelled T2 ends `cancelled` with its process gone), `src/loop/tick.ts` (cancelled or superseded: reap and end).

## Capabilities

### New Capabilities

### Modified Capabilities

- `health-monitoring`: "Process liveness", "Progress signals", "Stuck detection and escalation", "Launch time budget" and "Usage accounting" have their descriptions cut to one behavior each; the moved behaviors become 25 ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-health-monitoring-1/`. No code changes.
