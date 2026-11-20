# ACP probe of `opencode` 1.18.30 (`opencode --version`), model `opencode/big-pickle`, 2026-11-20

This probe (GH-197) asks whether the Agent Client Protocol (ACP, version 1) could serve as one session kind for the orchestrator's harnesses. It measures ACP on OpenCode, which is already a supported kind and offers a free model. A small ACP client drives `opencode acp` through one brief-shaped task in a linked git worktree, with a recording stand-in for the shim. The client keeps every frame. The eighteen questions below are each answered from that evidence, and set beside what `OpenCodeRunner` gets from `opencode run` (`src/runner/opencode.ts`, `test/fixtures/opencode/README.md`). Nothing under `src/` changed.

## Files

- `acp-client.mjs`: the ACP client. It uses Node built-ins only and writes the JSON-RPC framing by hand. It runs one process, one agent, one session and one turn. Its header lists the arguments, the stdout lines (`initialized`, `session`, `update`, `permission`, `usage`, `result`; also `extra` for `--requests-json`) and the exit codes. It runs the agent as a child in its own process group, with its own environment and working directory.
  - It sends `protocolVersion: 1` and advertises no `fs` and no `terminal` capability. It refuses every request from the agent other than `session/request_permission`.
  - It answers a permission request from the `--policy` file, always with an offered `allow_once` or `reject_once` option and never with an `*_always` option.
  - On SIGTERM or SIGINT it sends `session/cancel`, answers the pending permission requests `cancelled` and waits `--cancel-grace-ms` for the prompt's answer. It then closes the agent's stdin, gives what the agent started 2 s to end, kills what is left and exits 3.
  - Without `--prompt-file` it stops after `session/new` and exits 0.
  - `node acp-client.mjs --self-test` runs it against `fake-acp-agent.mjs` and needs no model and no CLI.
- `fake-acp-agent.mjs`: a scripted ACP agent for the self-test. Its scenarios are end-turn, permission, refusal, init-error, hang and hang-term.
- `recording-shim.mjs`: a stand-in for `orchestrator-mcp-shim`. It serves the five tools with their real names, descriptions and schemas.
  - At start it records its argv, its cwd, the names of its environment variables, the values of `ORCH_LAUNCH_ID`, `ORCH_TOKEN`, `ORCH_API` and `PROBE_MARKER` (with their source, env or `--orch-env-file`), and its parent chain.
  - It records every request and tool call, and answers `block` after `--block-sec` seconds (75 here). It never contacts a daemon.
  - It is registered with `process.execPath` as its command, because ACP wants an absolute path.
- `opencode/probe.mjs`: the probe.
  - `--run S0,S1,...` runs scenarios. Each scenario gets a fresh scratch directory, and each run writes its evidence and `records/<run>.json` as soon as it ends.
  - `--assemble` rebuilds `results.json` from `records/` and `answers.json`.
  - `--check` checks `results.json` and every evidence file. It needs no model and no `opencode`, and names the question whose evidence is missing.
- `opencode/results.json`: `cli`, `version`, `model`, `probedAt`, `questions` (`Q1` to `Q18`, from `answers.json`), `userConfig` and `runs` (every record).
- `opencode/answers.json`: the answers, written by hand from the evidence. Each holds `answer`, `summary`, `commands`, `evidence` (paths under `opencode/`) and `runs`.
- Evidence, one file per run, named after the run:
  - `frames/<run>.jsonl`: every frame of both directions, as `{t, dir: send|recv, msg}`. A non-JSON stdout line would be `{t, dir, raw}`; none occurred.
  - `client/<run>.jsonl`: the client's stdout.
  - `stderr/<run>.txt`: the agent's stderr, which the client copies.
  - `shim/<run>.jsonl`: the recording shim's file.
  - `logs/<run>.log`: `$XDG_DATA_HOME/opencode/log/opencode.log`.
  - `records/<run>.json`: the run record, holding the command, the environment, the exit, `orphans`, a process listing, `frameStats`, where the token was found, and the git and XDG facts.
  - `run/S9.jsonl`: stdout of the `opencode run` control.

## How the runs were made

- **Scratch.** Every scenario ran in a directory made with `mkdtemp` under the real path of `os.tmpdir()`, outside this repository, and removed at the end. It held:
  - `repo`, with one commit, `.orchestrator/` in `info/exclude`, the fixture identity in its own config and `commit.gpgsign` false;
  - `wt`, a linked worktree on `task/PROBE/l1`, which was always the session's directory;
  - `home`, the children's `HOME`, which also held S1e's env file.

  The script ran its own git with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
- **Environment.** Every child got an environment built by the script: `PATH`, `HOME` (the scratch home), `USER`, `LANG`, `TMPDIR`, `PWD`, and `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under `<scratch>/xdg/<run>/`. It also got the fake `ORCH_LAUNCH_ID=probe-launch`, `ORCH_TOKEN=orch-probe-token-<8 hex>` (one per run) and `ORCH_API=http://127.0.0.1:9`, the marker `PROBE_MARKER=from-client-env` and `OPENCODE_CONFIG_CONTENT`. Nothing of the worker's own environment was passed on. Each record's `env` shows values for these variables and only names for the rest.
- **Configuration.** `OPENCODE_CONFIG_CONTENT` was what `openCodeConfig` writes under `permission: derived`, minus the `mcp` block (the shim came over ACP), plus `model: opencode/big-pickle`. Its rules were `"*": "deny"`; the file tools `allow`; bash `"*": "deny"`, `git *` and `node *` `allow`; and `"orchestrator_*": "allow"`. The scenarios changed it as follows:
  - S2-S4 used `ASK_RULES`, with bash `"*": "ask"`;
  - S1d allowed `pwd`, and S5 and S6a allowed `sleep *`;
  - S7 set an unknown model;
  - S1b added the timeout.
- **Agent command.** `opencode acp --pure --print-logs --log-level WARN`, except for the two S0 runs without logs. The session's `cwd` was `<scratch>/wt`, and `mcpServers[0]` was the recording shim named `orchestrator`, with its identity in `env` (S1e used `--orch-env-file` instead).
- **Processes.** Every client (and the S9 `opencode run`) started detached, leading its own process group, under a hard time limit. Only that group was signalled at the limit.
  - The script sampled the client's process tree every 500 ms.
  - After each run, every process it had seen that was still alive with the same command was killed and named in `orphans`.
  - A saved process listing holds the rows of the run's own tree (`in: tree`) and the rows whose command is `opencode` (`in: opencode`), nothing else. The shim's parent chain is cut at the probe's own process.
- **Cost.** Only `opencode/big-pickle` was used, and the cost reported was 0 in every run. Scenarios with a model call: S1, S1b (two runs: `S1b`, `S1b-exp`), S1d, S1e, S1f, S2, S3, S4, S5, S6a (two runs: `S6a-term`, `S6a-kill`), S6b, S7 and S9. That is 13 scenarios, none with more than two runs. S0 (`S0-*`, `S0-model`) and S8 (`S8-1` to `S8-8`) sent no prompt.
- **Redaction**, as `test/fixtures/opencode/README.md` "Redaction" does it, on each decoded JSON string. The scratch directory becomes `<scratch>`, this checkout `<repo>` (a token added here), the home directory `~`, the name on every git identity line `Fixture Author` and every email `author@example.invalid`. ANSI colours are dropped from stderr. The model's text arrives in chunks of a few characters, so a path the model echoes is split across `agent_message_chunk` frames. Per-string redaction cannot join those pieces: `frames/S1d.jsonl` holds the scratch path under `/private/var/folders` (not the home directory) in pieces.
- **Two probe defects, fixed after the runs and kept in the evidence as they were.**
  - `records/S1d.json` names the shim in `killedDescendants` because the client then killed the agent's children at once. The shim had already recorded `stdinClosed`. The client now gives them 2 s.
  - `records/S6b.json` gives `parentExit.ms` as the time of the record, not of the parent's exit. The parent is a `spawnSync` that returned before the script started waiting for the result, so the turn did finish after the parent had exited. The script now records the right time.

## Runs

| Run | What | Model calls |
|---|---|---|
| S0-good, S0-good-logs | `initialize` and `session/new` with the shim, without and with `--print-logs`. Each `-logs` run also sends `session/set_model`, `session/set_config_option` (model), `session/set_mode` and an unknown `session/set_model` | 0 |
| S0-badshim, S0-badshim-logs | the same with a shim command that exits 1 (`--orch-env-file` naming a missing file) | 0 |
| S0-model | a valid non-default `model` in the config, then `session/set_config_option` with an unknown model and with `effort` | 0 |
| S1 | the task (`brief-q3.md` wording), the shim's identity in `env`, no timeout setting | 1 |
| S1b, S1b-exp | S1 with a disabled `mcp.orchestrator` entry carrying `timeout: 900000`, and with `experimental.mcp_timeout: 900000` | 1 each |
| S1e | S1 with the shim reading `--orch-env-file` and no `env` | 1 |
| S1d | `pwd` while `session/new.cwd`, `--cwd`, the spawn cwd and `$PWD` name four directories | 1 |
| S1f | a one-line prompt with a shim command that exits 1 | 1 |
| S2, S3, S4 | heartbeat, then `uname -s` under bash `ask`: rejected, allowed, unanswered and cancelled after 120 s | 1 each |
| S5 | `sleep 60`, cancelled (SIGINT to the client) 10 s into the command | 1 |
| S6a-term, S6a-kill | the same with SIGTERM, and with SIGKILL, to the client's group | 1 each |
| S6b | the client started as `SubprocessRunner` starts an agent, by a parent that exits at once | 1 |
| S7 | an unknown model (`opencode/gpt-bogus-9`) in `OPENCODE_CONFIG_CONTENT` | 1 |
| S8-1..S8-8 | eight clients started at once on one data directory, no prompt | 0 |
| S9 | S1's prompt through `opencode run --format json --pure --print-logs --log-level WARN -m opencode/big-pickle < prompt` with the shim in `mcp.orchestrator` (timeout 360000) | 1 |

Re-run one with `node test/fixtures/acp/opencode/probe.mjs --run <scenario>`. Scenarios: S0, S0m, S1, S1b, S1e, S1d, S1f, S2, S3, S4, S5, S6a, S6b, S7, S8 and S9.

## User configuration

`results.json` `userConfig` lists every file under `~/.config/opencode` except `node_modules`, with `sha256Before` (before the first run) and `sha256After` (after the last). None of the six files differs.
- The children ran with `HOME` and all four XDG directories under the scratch directory, so OpenCode wrote its database, log, cache and lock files there.
- `opencode --version` was the one command run with the real `HOME`, so that the version is that of the installed CLI.
- `~/.local/share/opencode` was not read or written by a run. Its files were not hashed, because the user's other OpenCode sessions write to it all the time.

## Answers

### 1. Does `opencode acp` answer `initialize` with protocol version 1, and which capabilities and auth methods does it state?

**yes**. It answers protocolVersion 1 with agentCapabilities loadSession true, mcpCapabilities {http, sse}, promptCapabilities {embeddedContext, image} and sessionCapabilities {close, fork, list, resume}, one auth method `opencode-login` ("Run `opencode auth login` in the terminal"), and agentInfo OpenCode 1.18.30.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S0`; `grep -m1 '"dir":"recv"' test/fixtures/acp/opencode/frames/S0-good.jsonl`

Evidence: `frames/S0-good.jsonl`, `client/S0-good.jsonl`

### 2. Does stdout carry only JSON-RPC frames, with and without `--print-logs`, and where do the logs go?

**partly**. Stdout carried only JSON-RPC frames in every run, with and without --print-logs (frameStats.nonJsonStdoutLines is 0 in every record), and with --print-logs --log-level WARN the log lines go to stderr and also to $XDG_DATA_HOME/opencode/log/opencode.log (S1f, S4), but where they go without --print-logs was not shown: stderr stayed empty and the log file was empty in the 1 s S0 runs both with and without the flag; a refused request also prints an "Error handling request" dump on stderr.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S0`; `cat test/fixtures/acp/opencode/stderr/S0-badshim.txt test/fixtures/acp/opencode/stderr/S0-badshim-logs.txt`; `grep -h nonJsonStdoutLines test/fixtures/acp/opencode/records/*.json | sort | uniq -c`; `cat test/fixtures/acp/opencode/logs/S1f.log test/fixtures/acp/opencode/logs/S4.log`; `wc -c test/fixtures/acp/opencode/logs/S0-*.log`

Evidence: `stderr/S0-badshim.txt`, `stderr/S0-badshim-logs.txt`, `logs/S0-badshim.log`, `logs/S0-badshim-logs.log`, `logs/S1f.log`, `logs/S4.log`, `stderr/S0-model.txt`, `records/S0-good.json`

### 3. Which directory does a session work in when `session/new.cwd`, `--cwd`, the spawn cwd and `$PWD` differ, and does the agent read, write and run commands itself there when the client advertises no `fs` and no `terminal`?

**yes**. The session works in session/new.cwd: with --cwd, the spawn cwd and $PWD naming three other directories, the agent's `pwd` printed <scratch>/wt and the shim started in <scratch>/wt; with no fs and no terminal capability the agent never sent an fs/* or terminal/* request in any run, and ran commands (S1d, S3), wrote greeting.txt and committed it (S1b) with its own tools.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S1d`; `grep -o '"rawOutput":{"output":"[^"]*"' test/fixtures/acp/opencode/frames/S1d.jsonl`; `grep -l '"method":"\(fs\|terminal\)/' test/fixtures/acp/opencode/frames/*.jsonl`; `grep -o '"cwd":"[^"]*"' test/fixtures/acp/opencode/shim/S1d.jsonl`

Evidence: `frames/S1d.jsonl`, `shim/S1d.jsonl`, `records/S1d.json`, `frames/S1b.jsonl`, `records/S1b.json`

### 4. Does a stdio server named in `session/new.mcpServers` start; with which environment (the listed variables, the parent's, both); under which parent process; and under which names does the model see its tools?

**yes**. It starts during session/new (the shim recorded initialize and tools/list in every S0 run, which sent no prompt) as a child of the `opencode acp` process in the client's process group, with both environments: OpenCode's own (the client's PROBE_MARKER) plus the listed entries (PROBE_FROM_SESSION), plus AGENT, OPENCODE, OPENCODE_CLIENT, OPENCODE_CONFIG_CONTENT, OPENCODE_PID, OPENCODE_PURE and npm_config_user_agent that OpenCode adds (and OPENCODE_PRINT_LOGS and OPENCODE_LOG_LEVEL under --print-logs, S0-good-logs); the model sees the tools as orchestrator_heartbeat, orchestrator_block, orchestrator_inbox, orchestrator_log and orchestrator_report (the tool_call titles).

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S0`; `head -1 test/fixtures/acp/opencode/shim/S0-good.jsonl`; `grep -ho '"title":"orchestrator_[a-z]*"' test/fixtures/acp/opencode/frames/S1.jsonl test/fixtures/acp/opencode/frames/S1b.jsonl | sort -u`

Evidence: `shim/S0-good.jsonl`, `shim/S0-good-logs.jsonl`, `frames/S1.jsonl`, `frames/S1b.jsonl`, `client/S3.jsonl`

### 5. When that server's command cannot start, is it an error of `session/new`, a failed prompt, or a turn without the tools?

**yes**. A turn without the tools: session/new answers normally (S0-badshim, S1f), stderr gets `level=WARN message="server unavailable" key=orchestrator type=local status=failed` only under --print-logs, and in S1f the prompt ended end_turn with the model replying NO-TOOL; no frame says the server is missing.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S1f`; `cat test/fixtures/acp/opencode/stderr/S1f.txt`; `grep '"type":"result"' test/fixtures/acp/opencode/client/S1f.jsonl`; `head -1 test/fixtures/acp/opencode/shim/S1f.jsonl`

Evidence: `frames/S1f.jsonl`, `stderr/S1f.txt`, `client/S1f.jsonl`, `shim/S1f.jsonl`, `frames/S0-badshim.jsonl`, `stderr/S0-badshim-logs.txt`

### 6. Is the `block` call answered after 75 s cut for a server passed over ACP, and does a per-launch setting (`OPENCODE_CONFIG_CONTENT` with `mcp.orchestrator.timeout`) lift the limit?

**yes**. Yes and yes: with no timeout setting (S1) every `block` call failed at 60 s with "MCP error -32001: Request timed out" although the shim answered at 75 s; a disabled `mcp.orchestrator` entry in OPENCODE_CONFIG_CONTENT carrying only `timeout: 900000` (S1b) lifted the limit for the server passed over ACP, so both 75 s `block` calls completed with the answer, and that entry's own command never started (configShimCalls 0); and `experimental.mcp_timeout: 900000` (S1b-exp) did the same.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S1`; `node test/fixtures/acp/opencode/probe.mjs --run S1b`; `grep -o '"text":"MCP error -32001: Request timed out"' test/fixtures/acp/opencode/frames/S1.jsonl | wc -l`; `grep '"answered"' test/fixtures/acp/opencode/shim/S1b.jsonl`

Evidence: `frames/S1.jsonl`, `shim/S1.jsonl`, `frames/S1b.jsonl`, `shim/S1b.jsonl`, `records/S1b.json`, `shim/S1b-exp.jsonl`, `records/S1b-exp.json`

### 7. Does `OPENCODE_CONFIG_CONTENT` (the permission ruleset, `snapshots: false`, `share: disabled`, `model`) apply to a session of `opencode acp`?

**partly**. The permission ruleset applies (the `ask` rules of S2-S4 produced session/request_permission, the `deny` rule of S1 refused `sleep 60` naming the rules), and a valid `model` applies (S0-model: currentValue opencode/nemotron-3.5-lightning-free), but an unknown `model` is dropped without a word (S7), and whether `snapshots: false` and `share: disabled` apply was not shown (no run went without them, and the one data directory listed, S1's, belongs to a run that edited no file).

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S0m`; `node test/fixtures/acp/opencode/probe.mjs --run S7`; `grep -o '"currentValue":"[^"]*"' test/fixtures/acp/opencode/client/S0-model.jsonl test/fixtures/acp/opencode/client/S7.jsonl`; `grep -o 'The user has specified a rule which prevents you[^\\]*' test/fixtures/acp/opencode/frames/S1.jsonl | head -1`; `grep -c request_permission test/fixtures/acp/opencode/frames/S2.jsonl`

Evidence: `client/S0-model.jsonl`, `client/S7.jsonl`, `frames/S2.jsonl`, `frames/S1.jsonl`, `records/S1.json`

### 8. Under a rule that asks, does the agent send `session/request_permission`, with which options and which fields naming the command; and are the shim's tools asked for or pre-approved by `"orchestrator_*": "allow"`?

**yes**. Under bash `"*": "ask"` the agent sends session/request_permission with the options once/allow_once "Allow once", always/allow_always "Always allow" and reject/reject_once "Reject" (no reject_always), naming the command in toolCall.title and toolCall.rawInput.command (kind execute); orchestrator_heartbeat ran with no request, pre-approved by "orchestrator_*": "allow", and a `deny` rule sends no request at all.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S2`; `grep request_permission test/fixtures/acp/opencode/frames/S2.jsonl`; `grep '"type":"permission"' test/fixtures/acp/opencode/client/S3.jsonl`

Evidence: `frames/S2.jsonl`, `client/S2.jsonl`, `client/S3.jsonl`, `frames/S1.jsonl`

### 9. After `reject_once`, does the model get an error and the turn go on, or does the turn end as it does under `opencode run`? After `allow_once`, does the command run? With no answer, what does the turn do within 120 s?

**yes**. After reject_once the tool call is marked failed ("The user rejected permission to use this specific tool call.") and session/prompt answers end_turn 4 ms later with no model step between, so the turn ends as under `opencode run` and the model never sees the error (no FALLBACK-OK); after allow_once `uname -s` ran and the model replied Darwin; with no answer the turn sent no frame for 120 s (frameStats.maxGapMs 120005) until session/cancel, after which the tool failed and the prompt answered cancelled.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S2`; `node test/fixtures/acp/opencode/probe.mjs --run S3`; `node test/fixtures/acp/opencode/probe.mjs --run S4`; `tail -3 test/fixtures/acp/opencode/frames/S2.jsonl`; `grep -o '"maxGapMs": [0-9]*' test/fixtures/acp/opencode/records/S4.json`

Evidence: `frames/S2.jsonl`, `frames/S3.jsonl`, `frames/S4.jsonl`, `records/S4.json`

### 10. How does a turn end: the `stopReason`; whether the process stays up afterwards; what ends it (closing stdin, SIGTERM); with which exit code?

**yes**. A completed turn ends with the session/prompt result `stopReason: end_turn` and a `usage` object; the agent stays up after the turn until the client closes its stdin, then exits with code 0 (agentExit.how stdinClosed after every completed turn, S1b, S2, S3, S1d, S7), while SIGTERM to the group ends it by the signal (code null, signal SIGTERM) before it answers the prompt.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S3`; `node test/fixtures/acp/opencode/probe.mjs --run S6a`; `grep -ho '"stopReason":"[a-z_]*"\|"agentExit":{[^}]*}' test/fixtures/acp/opencode/client/S1b.jsonl test/fixtures/acp/opencode/client/S3.jsonl test/fixtures/acp/opencode/client/S6a-term.jsonl`

Evidence: `client/S3.jsonl`, `client/S1b.jsonl`, `client/S2.jsonl`, `client/S6a-term.jsonl`

### 11. Does `session/cancel` during a 60 s shell command end the turn with `cancelled`, how soon, and do the command's process and the shim's process end?

**yes**. session/cancel sent 10 s into `sleep 60` was answered `stopReason: cancelled` 15 ms later (frames t 13682 and 13697), the `sleep` process ended (no orphan), and the shim stayed up with the session until the agent's stdin was closed, then exited by itself.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S5`; `grep -n 'session/cancel\|"stopReason"' test/fixtures/acp/opencode/frames/S5.jsonl`; `node -e "console.log(require('./test/fixtures/acp/opencode/records/S5.json').orphans, require('./test/fixtures/acp/opencode/records/S5.json').driven.treeBeforeCancel)"`

Evidence: `frames/S5.jsonl`, `records/S5.json`, `shim/S5.jsonl`, `client/S5.jsonl`

### 12. Does SIGTERM to the client's process group during a turn leave a process; what is left after SIGKILL of that group; and does a client started as `SubprocessRunner` starts an agent (detached, stdin ignored, stdout and stderr in one file) finish its turn after its parent has exited?

**yes**. Both signals leave the bash tool's `sleep 60`, which OpenCode starts in a process group of its own (pgid = its pid), while the client, `opencode acp` and the shim are in the client's group and end (the shim recorded the SIGTERM); the probe had to kill the `sleep` both times (orphans); a client started detached with stdin ignored and stdout and stderr in one file finished its turn (DONE, exit 0, no orphan) after its parent had exited.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S6a`; `node test/fixtures/acp/opencode/probe.mjs --run S6b`; `node -e "for (const r of ['S6a-term', 'S6a-kill', 'S6b']) console.log(r, JSON.stringify(require('./test/fixtures/acp/opencode/records/' + r + '.json').orphans))"`

Evidence: `records/S6a-term.json`, `records/S6a-kill.json`, `shim/S6a-term.jsonl`, `records/S6b.json`, `client/S6b.jsonl`

### 13. Which usage does ACP carry (the fields of `usage_update`, a `usage` on the prompt response, a cost), and how does it compare with the tokens and cost `opencode run --format json` reports for the same prompt?

**yes**. The prompt response carries `usage` {inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens} and one `usage_update` {used, size, cost {amount, currency}} arrives at the end of the turn, but both describe the last step (the last assistant message) only, not the turn: for the task prompt ACP reported 996 input, 35 output and 9984 cache-read tokens where `opencode run --format json` summed 11041, 1419 and 99328 over 14 steps (its last step alone was 720, 28 and 8960); cost was 0 both ways (free model), and ACP reports no step or turn count.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S1b`; `node test/fixtures/acp/opencode/probe.mjs --run S9`; `grep '"stopReason"' test/fixtures/acp/opencode/frames/S1b.jsonl`; `node -e "console.log(require('./test/fixtures/acp/opencode/records/S9.json').usage)"`

Evidence: `frames/S1b.jsonl`, `records/S1b.json`, `run/S9.jsonl`, `records/S9.json`

One prompt (the task prompt of S1, from `brief-q3.md`) run both ways, on the same CLI and model:

| | `opencode run --format json` (S9) | ACP `opencode acp` (S1b) |
|---|---|---|
| input tokens | 11041 | 996 |
| output tokens | 1419 | 35 |
| cache read tokens | 99328 | 9984 |
| cost | 0 | 0 |
| turns | 1 | not reported |

Evidence: `run/S9.jsonl` with `records/S9.json` (`usage`), and `frames/S1b.jsonl` with `records/S1b.json` (`frameStats.promptAnswer`, `frameStats.lastUsage`).
- The `opencode run` column sums the 14 `step_finish` events. Its cost is `step_finish.cost` (free model), and its turn is the `step_finish` with `reason: "stop"`.
- The ACP column holds `usage.inputTokens`, `usage.outputTokens` and `usage.cachedReadTokens` of the prompt response, and the cost is `usage_update.cost.amount` (currency USD).
- These ACP numbers are of the same size as S9's last step alone (720 input, 28 output, 8960 cache read). ACP carries the last step, not a total for the turn.

### 14. How are the model and the effort chosen for a session: an option in the `session/new` answer, a set-model method, or only configuration?

**yes**. All three for the model: the session/new answer carries configOptions `model` (a select with currentValue and the options) and `mode` (build, plan); session/set_model and session/set_config_option {configId: "model"} both take a model, and refuse an unknown one with -32602 "Invalid params: model not found"; `model` in OPENCODE_CONFIG_CONTENT sets the default; no effort option is offered for these models and set_config_option {configId: "effort"} answers -32602 "effort not found: high"; the list of options differed between two fresh starts ("OpenCode/…" against "OpenCode Zen/…" names).

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S0`; `node test/fixtures/acp/opencode/probe.mjs --run S0m`; `grep '"type":"extra"' test/fixtures/acp/opencode/client/S0-good-logs.jsonl test/fixtures/acp/opencode/client/S0-model.jsonl`

Evidence: `client/S0-good-logs.jsonl`, `client/S0-model.jsonl`, `client/S0-good.jsonl`

### 15. How do an unknown model, a server that did not start and a rejected permission show in the frames and on stderr, and can the reasons of `classifyOpenCodeFailure` be told apart?

**partly**. An unknown model in the configuration shows nowhere (S7 ran the default model, empty stderr), while one set over ACP is a JSON-RPC error -32602 "model not found" plus an "Error handling request" dump on stderr; a server that did not start shows only as the WARN `server unavailable key=orchestrator` on stderr under --print-logs (which the mcpStartupFailed pattern matches); a rejected permission shows only in the frames (a failed tool_call_update with "The user rejected permission…" and end_turn), with no `auto-rejecting` line; so mcpStartupFailed can be told apart, unknownModel only when the client sets the model itself, permissionDenied only from the frames, and authFailed was not probed (the free model needs no login).

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S7`; `node test/fixtures/acp/opencode/probe.mjs --run S0m`; `node test/fixtures/acp/opencode/probe.mjs --run S1f`; `node test/fixtures/acp/opencode/probe.mjs --run S2`; `cat test/fixtures/acp/opencode/stderr/S7.txt test/fixtures/acp/opencode/stderr/S1f.txt test/fixtures/acp/opencode/stderr/S2.txt`

Evidence: `stderr/S7.txt`, `client/S0-model.jsonl`, `stderr/S0-model.txt`, `stderr/S1f.txt`, `frames/S2.jsonl`, `stderr/S2.txt`

### 16. What does the stream show while the agent waits: are there frames during the 75 s tool call, and what is the longest gap between two frames of the task run?

**yes**. Nothing arrives while a tool call runs: in S1b each 75 s `block` call left a gap with no frame of 75017 and 75159 ms (the longest), in S1 the cut calls left 60 s gaps, and in S4 the unanswered permission request left 120005 ms; progress otherwise streams as session/update frames (thought and message chunks, tool_call and tool_call_update) as the agent works.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S1b`; `grep -o '"maxGapMs": [0-9]*' test/fixtures/acp/opencode/records/S1.json test/fixtures/acp/opencode/records/S1b.json test/fixtures/acp/opencode/records/S4.json`

Evidence: `records/S1b.json`, `records/S1.json`, `records/S4.json`, `frames/S1b.jsonl`

### 17. Of 8 clients started in the same instant on one data directory, with no prompt sent, how many fail `initialize` or `session/new`, and with which message?

**yes**. None: all 8 clients started together on one XDG_DATA_HOME answered initialize and session/new and exited 0 in 1.6-2.6 s, with no `database is locked` line on any stderr.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S8`; `grep -h '"type":"result"' test/fixtures/acp/opencode/client/S8-*.jsonl`; `cat test/fixtures/acp/opencode/stderr/S8-*.txt`

Evidence: `client/S8-1.jsonl`, `client/S8-2.jsonl`, `client/S8-3.jsonl`, `client/S8-4.jsonl`, `client/S8-5.jsonl`, `client/S8-6.jsonl`, `client/S8-7.jsonl`, `client/S8-8.jsonl`, `stderr/S8-1.txt`, `stderr/S8-2.txt`, `stderr/S8-3.txt`, `stderr/S8-4.txt`, `stderr/S8-5.txt`, `stderr/S8-6.txt`, `stderr/S8-7.txt`, `stderr/S8-8.txt`

### 18. Does the agent commit on the launch branch in the linked worktree, and is the fake token found under the data directory or in the logs after the run?

**yes**. The agent committed greeting.txt as dbe1709 "Add greeting file" on task/PROBE/l1 in the linked worktree <scratch>/wt and left it clean (S1b; S9 did the same through `opencode run`); the fake token was never found under the run's XDG data, state, cache or config directories nor on stderr: passed in the session/new `env` it is in the client's frames file only (S1, S1b), and passed through `--orch-env-file` (S1e) it is nowhere but the shim's own record, so the env file keeps it out of the frames as well.

Commands: `node test/fixtures/acp/opencode/probe.mjs --run S1b`; `node test/fixtures/acp/opencode/probe.mjs --run S1e`; `grep -A3 '"branchLog"' test/fixtures/acp/opencode/records/S1b.json`; `grep -h -A1 '"tokenFoundIn"\|"fileTokenFoundIn"' test/fixtures/acp/opencode/records/S1.json test/fixtures/acp/opencode/records/S1b.json test/fixtures/acp/opencode/records/S1e.json`

Evidence: `records/S1b.json`, `records/S1e.json`, `records/S1.json`, `shim/S1e.jsonl`, `frames/S1e.jsonl`


## For the decision record

Each cell is `pass`, `fail`, `partly` or `not probed`, with the question (Q) of this probe or the fixture file it rests on. The column `opencode run` comes from the shipped code and `test/fixtures/opencode/README.md` ("the fixtures README" below).

| Criterion | `opencode run` | `opencode acp` |
|---|---|---|
| C1 Registration | pass: the shim is `mcp.orchestrator` in a per-launch `OPENCODE_CONFIG_CONTENT`, and `.orchestrator/opencode.json` is under `.orchestrator/` (`test/fixtures/opencode/brief-run/cfg-q3.json`, `src/runner/opencode.ts` openCodeConfig) | pass: registered per session in `session/new.mcpServers`, with the launch's identity in `env` or `--orch-env-file`. No configuration was written, and the worktree held no new file (Q4, Q18, `records/S1.json` git) |
| C2 Required | partly: there is no `required` analog. The WARN `server unavailable` is classified as `mcpStartupFailed` after the turn (`test/fixtures/opencode/events/D4.err`, `test/fixtures/opencode/events/D4.jsonl`) | partly: `session/new` does not fail. The WARN is on stderr, under `--print-logs` only, before any prompt is sent, so a client can read it before paying for a turn; no frame says it (Q5, Q15) |
| C3 No human | pass with the derived `deny` catch-alls: the refusal comes back to the model and the run goes on; an `ask` is auto-rejected and ends the run (`test/fixtures/opencode/events/P-deny.jsonl`, `test/fixtures/opencode/events/P-ask.jsonl`) | pass with `deny`: in S1b the denied `od` command came back as an error and the model asked a `needsAccess` question. `ask` with `reject_once` ends the turn, and an unanswered `ask` waits until cancelled (Q8, Q9, `shim/S1b.jsonl`) |
| C4 Rules | pass: the derived ruleset in `OPENCODE_CONFIG_CONTENT`, matched per command (`test/fixtures/opencode/events/X-chain-allowed.jsonl`, `test/fixtures/opencode/events/X-chain-offpattern.jsonl`) | pass: the same ruleset applies under ACP, and an `ask` rule can also be answered per request by the client's policy file (Q7, Q8) |
| C5 Timeout | pass: `mcp.orchestrator.timeout` = `maxWaitMs + 60000` (`test/fixtures/opencode/events/T4.jsonl`, `test/fixtures/opencode/configs/cfg-slow-perserver.json`) | pass: a disabled `mcp.orchestrator` entry with `timeout` in `OPENCODE_CONFIG_CONTENT` lifts the 60 s cut for the server passed over ACP (Q6) |
| C6 Commit | pass: the agent commits in the worktree (`test/fixtures/opencode/brief-run/Q3-1.jsonl`, and S9 here) | pass: `dbe1709` on `task/PROBE/l1` in the linked worktree (Q18) |
| C7 Selection | partly: model `-m {model}`; effort `--variant` is accepted silently on a model without variants (`test/fixtures/opencode/events/I1.jsonl`) | partly: model by `model` in the configuration (an unknown one is dropped silently) or by `session/set_config_option`, which refuses an unknown one. Effort only as a `effort` option, refused for these models, and the model list varied between starts (Q14, Q7) |
| C8 Usage | pass: input, output, reasoning and cache tokens and cost summed over every `step_finish` (`test/fixtures/opencode/events/SA-proj2.jsonl`, `src/runner/opencode.ts` parseOpenCodeUsage) | fail: the prompt response `usage` and the one `usage_update` describe the last step only, so the launch's input and output tokens cannot be read; a cost is reported, and the model is known from the configuration (Q13) |
| C9 Failures | pass: seven reasons from stdout events and WARN/ERROR lines; an unknown model needs an ERROR line (`test/fixtures/opencode/events/E-badmodel.jsonl`, `test/fixtures/opencode/events/D4.err`, `test/fixtures/opencode/events/K2.err`) | partly: a shim that did not start shows as the same WARN, and a model set over ACP gives -32602. An unknown model in the configuration shows nowhere, a rejected action shows only in frames, and a missing credential was not probed (Q15) |
| C10 Isolation | partly: `dataDir: launch` and `ignoreUserConfig` are options; on the shared database 4 of 23 starts died `database is locked` (`test/fixtures/opencode/events/K2.err`, `test/fixtures/opencode/events/SA-proj.err`) | pass under the probe's environment: `HOME` and all four XDG directories per launch (set by the probe's environment, which `opencode run` can be given as well), and every `~/.config/opencode` hash unchanged. 8 of 8 simultaneous starts ran on one fresh, empty data directory, with no prompt sent (Q17, User configuration) |
| C11 Process | partly: detached, with JSONL output while it works (`test/fixtures/opencode/e2e-T2.jsonl`, `src/runner/subprocess.ts`); whether the bash tool's command leaves the group was not probed for `opencode run` | partly: the client, the agent and the shim share the group, but the bash tool's command runs in a group of its own and outlives SIGTERM and SIGKILL of the group. The agent ends when stdin is closed and `session/cancel` works; no frame arrives during a long tool call (Q10, Q11, Q12, Q16) |
| C12 Stability and residue | partly: the `--format json` events are not a versioned interface (`test/fixtures/opencode/events/C2.jsonl`). Per harness: the launch command, the environment, the permission configuration, `-m`/`--variant`, the failure patterns and the tool-name wording (`src/runner/opencode.ts`) | partly: ACP version 1 is documented and versioned (Q1), and frames, the session directory, MCP registration, permission answers, cancel and stop reasons are common. Still per harness: the launch command (`opencode acp --pure`), the environment (`OPENCODE_CONFIG_CONTENT`, XDG), the configuration that makes it ask or stop asking, the model setter (config or `set_config_option` id `model`), the failure patterns (the stderr WARN, -32602) and the tool-name wording (`orchestrator_<tool>`): 6 of 6 items remain (Q2, Q4, Q14, Q15) |
