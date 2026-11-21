# Probe of `hermes` `Hermes Agent vunknown (2026.9.24)` (Homebrew hermes-agent 0.22.4_1), provider `nous`, model `qwen/qwen4-max:free`, 2026-11-20

This probe (GH-199) asks whether Hermes Agent, the Nous Research CLI `hermes`, could be supervised as an orchestrator worker. It answers sixteen questions for the installed version, both headless (`hermes -z`, `hermes chat -q`) and over the Agent Client Protocol (`hermes acp`, driven by the client of GH-197). Every answer rests on a run of `probe.mjs` and its saved evidence. Nothing under `src/` changed.

**The headline finding is question 2.** Neither form runs the work under the process the caller starts.

- `hermes -z`, `hermes chat` and `hermes acp` are clients of a gateway daemon. The first client on a `HERMES_HOME` starts it (`hermes_cli.main --profile default gateway run --quiet --idle-exit`), in a process group of its own.
- The gateway starts the MCP servers (the shim), an `mcp_death_supervisor` and every shell command of a turn (`bash -c ...`), each in a process group of its own again.
- The gateway outlives the client (ppid 1 afterwards, until a 600 s idle exit). Headless, the shim and the supervisor outlive it too. A second client on the same home attaches to the running gateway.
- SIGTERM to the started process group ended only the started process. The gateway, the shim, the supervisor, the `bash` and its `sleep 120` all kept running (H2k, A2k). An integration would need one `HERMES_HOME` per launch, and would have to end that home's gateway itself, by the pid the home records.

**Other findings that decide an integration.**

- The default limit of an MCP tool call is 300 s, both forms (H8a, A8a). `timeout` on the `mcp_servers` entry lifts it headless (H8x). A server named over ACP has no such field.
- Headless `chat -q` refuses a dangerous command at once, without waiting, unless the per-launch `config.yaml` sets `approvals.mode: off` (H9c, H8x). Over ACP the same command becomes a `session/request_permission` (A11c).
- A hardline guard blocks every **relative** `rm` argument as a delete of "this Hermes runtime's own virtualenv", under every approval setting. It resolves the path against the gateway's working directory, which is inside the hermes install (H9a, H9b, H10a, A11a, A11b, `headless/gateway-cwd.txt`).
- A shim that does not start leaves no trace in the output or the exit code (H7).

## Preflight

`node test/fixtures/hermes/probe.mjs --preflight --provider nous --model qwen/qwen4-max:free`, the run the probe was made with (16:50 CST, `headless/preflight.txt`, `headless/preflight.json`):

```
ok: hermes binary /opt/homebrew/bin/hermes
ok: version Hermes Agent vunknown (2026.9.24)
ok: hermes acp --check exit 0 Hermes ACP check OK
ok: user Hermes home ~/.hermes
ok: probe provider and model nous qwen/qwen4-max:free (from --provider/--model)
ok: credential works under a scratch HERMES_HOME exit 0, reply "ok" (copied .env, auth.json)
```

The first preflight (15:03, `headless/preflight-first.txt`, from the first attempt at this task) found no `~/.hermes`, no provider and no credential. The probe asked once (`needsAccess`). The owner set Hermes up and answered `ready nous qwen/qwen4-max:free`. The issue line still reads `Probe provider and model: (not named yet)`, so the provider and the model are passed with `--provider` and `--model`. They are also the default of the owner's `~/.hermes/config.yaml`.

## Files

- `probe.mjs`: the probe.
  - `--preflight` prints one line per prerequisite, writes `headless/preflight.txt` and `headless/preflight.json`, and records its one prompt as run `P0-preflight`.
  - `--run <ids>` runs scenarios, each in a fresh scratch directory. Each run writes its evidence and `records/<run>.json` as soon as it ends, appends a line to `spend.jsonl`, then `results.json` is rebuilt.
  - `--assemble` rebuilds `results.json` from `records/` and `answers.json`.
  - `--check` checks `results.json` and every evidence file. It needs no model and no `hermes`, and prints `hermes probe: N of 16 questions recorded`.
  - `--bin <path>` (default `hermes`), `--provider <p>` and `--model <m>` (they override the issue's `Probe provider and model:` line).
- `acp-client.local.mjs`: a copy of `../acp/acp-client.mjs` (GH-197) with one difference, `--keep-descendants`. With it, the client lists what the agent left behind after it exited (`leftDescendants` in its `result` line) instead of killing it. The original kills every descendant of the agent 2 s after the agent exits, which would have hidden the gateway daemon of question 2. The probe ends those processes itself and names them in `orphans`. Without the flag the copy behaves as the original, and `node acp-client.local.mjs --self-test` passes against `../acp/fake-acp-agent.mjs`.
- `answers.json`: the answers, written by hand from the evidence.
- `results.json`: `cli`, `bin`, `version`, `provider`, `model`, `probedAt`, `preflight`, `questions` (`Q1` to `Q16`, from `answers.json`), `userConfig` (from the records) and `runs` (every record, shortened).
- `spend.jsonl`: one line per run ever made, reruns included, with its `modelCalls`. It is append-only, so a rerun cannot hide spend.
- Evidence, one set of files per run, named after the run:
  - `headless/<run>.out`, `.err`: stdout and stderr of a headless run.
  - `headless/<run>.usage.json`: the `--usage-file` of a `-z` run, when one was written.
  - `acp/<run>.frames.jsonl`: every ACP frame of both directions. `acp/<run>.client.jsonl`: the client's stdout. `acp/<run>.stderr.txt`: the agent's stderr.
  - `<dir>/<run>.ps.json`: the process listings: `before`, `during` (every second, kept when the set of pids changed), `after`, `seen` (every pid of the started tree or group, with its command line), `leftAfterExit` and `homePids` (pid files in the scratch home). Each listing holds only the rows of the probe's own tree (`in: tree`), of the started child's tree or group (`in: started`), and of processes whose command line runs the hermes install (`in: hermes`). On macOS a hermes process shows `comm` = `Python`, so the probe marks rows by their command line.
  - `<dir>/<run>.logs.txt`: the logs under the scratch `HERMES_HOME/logs/`.
  - `shim/<run>.jsonl`: the recording shim's file (`../acp/recording-shim.mjs`): its start (argv, cwd, the names of its environment variables, the values of the fake `ORCH_*` and the marker, its parent chain cut at the probe), every request and every tool call.
  - `records/<run>.json`: the command, the environment (values only for the probe's own variables), the exit, `orphans`, `carriedToNextRun`, the scratch home's files, where the fake token was found, the git facts, the user configuration hashes before and after, and for the `rm` runs `rmTargetAfter`.
  - `headless/gateway-cwd.txt`: the working directory of the running gateways (`lsof -a -d cwd`), taken by hand during H10b. It is the one piece of evidence not written by `probe.mjs`.

## How the runs were made

- **Scratch.** Every scenario ran in a directory made with `mkdtemp` under the real path of `os.tmpdir()`, outside this repository, and removed in an exit handler that also runs when the script fails. It held `repo` (one commit, `.orchestrator/` in `info/exclude`, the fixture identity in its own config), `wt` (a linked worktree on `task/PROBE/l1`, always the working directory) and `home` (the children's `HOME`, with `home/.hermes` as `HERMES_HOME`). The probe's own git ran with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
- **Environment.** Every child got an environment built by the probe: `PATH`, `HOME` and `HERMES_HOME` under `<scratch>`, `USER`, `LANG`, `TMPDIR`, the fake `ORCH_LAUNCH_ID=probe-launch`, `ORCH_TOKEN=orch-probe-token-<8 hex>` (one per run), `ORCH_API=http://127.0.0.1:9`, and the marker `PROBE_MARKER=from-client-env`. Nothing of the worker's own environment was passed on. No provider key was exported for the worker. **No run used the user's home**: every record's `env.HERMES_HOME` is under `<scratch>`.
- **Configuration.** The scratch `config.yaml` is JSON, which is also YAML. Model runs set `model: {default: qwen/qwen4-max:free, provider: nous}` and pass `--provider nous -m qwen/qwen4-max:free` on headless command lines. Headless runs register the shim as `mcp_servers.orchestrator` with `command` = node, `args` = the shim and its calls file, and `env` = the three fake `ORCH_*` values and `PROBE_MARKER=from-mcp-entry`. ACP runs name it in `session/new.mcpServers` instead. The no-model runs of the first attempt (A0, C0-acp, D2, D3, D2k, D7, D16) used a placeholder `openrouter` model with no key, so that a turn started and stopped at the provider call.
- **Credentials.** A run copies `.env` and `auth.json` of the user's home into its scratch home, without reading them into any output. Before an evidence file is written, the probe checks that it holds none of their credential-shaped values and replaces any it finds with `<credential>`. `headless/H9c.logs.txt` holds 30 of these placeholders, 28 of them as `base_url=<credential>`, and 21 evidence files hold at least one (`grep -o '<credential>' test/fixtures/hermes/headless/H9c.logs.txt | wc -l`; `grep -rlF --exclude='*.mjs' --exclude=README.md '<credential>' test/fixtures/hermes | wc -l`).
- **Processes.** Every child started detached, leading its own process group, under a hard limit (300 s, 610 s for the Q8 runs). At the limit only that group is signalled. The probe sampled `ps` every second. After each run, every process it had seen in the child's tree or group that was still alive with the same command was ended and named in `orphans`. So was a gateway whose pid the scratch home records (`gateway.pid`), when its command line is `hermes_cli.main ... gateway run`. Two hermes processes the probe did not start (pids 65645 and 65648: a `hermes` started from a terminal shell, and its gateway) appear in the listings as `in: hermes` and were left alone.
- **Cost.** 20 runs called a model: `P0-preflight` and H2, H2k, A2, A2k, H3, H3b, H7, H8a, H8x, A8a, H9a, H9b, H9c, H10a, H10b, A11a, A11b, A11c and H13. `results.json` counts them (`modelCalls: 1`) and `spend.jsonl` has every run, 21 lines with `modelCalls` 1: the 20 above and the first attempt's `P0-preflight`, which exited 1 before any provider call because none was configured (its record was replaced by this attempt's). The free model reports `estimated_cost_usd: 0`. One `chat` run (H3) was ended by the probe's 300 s limit.
- **Redaction**, as `test/fixtures/opencode/README.md` "Redaction" does it, on each decoded JSON string. The scratch directory becomes `<scratch>`, the real temporary directory `<tmpdir>`, this checkout `<repo>`, the home directory `~`, every git identity `Fixture Author` and every email `author@example.invalid`. ANSI colours are dropped. Model text in `stream-json` `text` lines and in ACP `agent_message_chunk` frames arrives in small pieces, so a path the model echoes can be split across lines. Where a command printed `ls -l` output, the owner column reads `user` (`headless/H10a.out`), since the scrub below.
- **The scrub of 2026-11-20.** Host data that the redaction above missed was removed from the committed evidence by hand on 2026-11-20, and #208 re-scrubbed it with `node probe.mjs --scrub`. It removed:
  - the gateway's shutdown diagnostics block, which listed every process of the host: each block is now the one line `=== shutdown diagnostic removed: it listed every process of the host ===` (27 evidence files), and the home's `gateway-shutdown-diag.log` is not copied;
  - the start-up audit lines, every line holding `hermes.security_audit`;
  - the user name in `ls -l` output, now `user`.

  The placeholders the scrub and the probe use are `user` (the user name, written by the hand scrub), `<user>` (the user name as a whole word), `<PATH>` (a shell `PATH` list), `<project>` (an Antigravity project id; agy only, so it does not occur here), `<tmpdir>` (the real path of `os.tmpdir()`) and `<value>` (a value in an environment listing, outside `ORCH_*`, `PROBE_MARKER`, `HOME`, `PWD`, `LANG`, `TERM` and `SHLVL`). In this probe's evidence only `user` and `<tmpdir>` occur. Since #208 the probe redacts all of these itself when it writes evidence, and `node probe.mjs --check` fails when a file still holds host data.

## Runs

| Run | What | Model calls |
|---|---|---|
| P0-preflight | `hermes -z "Reply with the single word ok."` under a scratch home holding the copied credential files | 1 |
| H2 | `-z`: call the heartbeat tool, run `sleep 15 && pwd`, reply `done`; the shim in the scratch config; `--usage-file` | 1 |
| H2k | `-z`: run `sleep 120`; SIGTERM to the started group once `sleep` is seen | 1 |
| A2, A2k | the same two over ACP, the shim on `session/new`, policy `allow` (allow_once only) | 1 each |
| H3 | `chat --query-file <30,079-byte brief> --oneshot --format stream-json --max-turns 12`: heartbeat, write a file, commit, report | 1 |
| H3b | `chat -q` asking for three terminal calls, `--max-turns 1` on purpose | 1 |
| H7 | `chat -q` with a shim command that exits 1 | 1 |
| H8a | `chat -q`: call `block`, answered after 310 s; no timeout set | 1 |
| A8a | the same over ACP | 1 |
| H8x | `chat -q` with `timeout: 430` on the entry and `approvals.mode: off`: `rm -r <absolute path in the worktree>`, then `block` answered after 310 s | 1 |
| H9a, H9b | `rm -r ./probe-rm-target .` under `chat -q` and `-z` (a probe defect: the prompt ended the command with ` .`) | 1 each |
| H10a | `rm -r ./probe-rm-target` under `chat -q` with `approvals.mode: off` | 1 |
| H9c | `rm -r <absolute path in the worktree>` under `chat -q`, default approvals | 1 |
| H10b | `--toolsets file,mcp-orchestrator` and `tools.include` without `log`: ask for `log` and `uname -s` | 1 |
| A11a, A11b | ACP `rm -r ./probe-rm-target` with a reject policy, and with no answer and `approvals.timeout: 30` | 1 each |
| A11c | ACP `rm -r <absolute path in the worktree>` with a reject policy | 1 |
| H13 | `-z -m probe-no-such-model-9` | 1 |
| N0, N1, A0, C0, D2, D2k, D3, D7, D16 | no-model runs of the first attempt: help texts, `hermes mcp test`, ACP `initialize`/`session/new`, no credential, no-key turns | 0 |

**Not run, at the cap of 20.** In the brief's order of dropping (16, 11, 9):

- H16, two model runs at once on one home. Question 16 rests on D16, two no-key runs.
- A11d, an unanswered permission request with `approvals.timeout: 30` (question 11).
- `-z` with an absolute-path `rm -r` (question 9).

Questions 8 and 10 also lost a scenario each:

- A8b, `timeouts.mcp.tool_call` over ACP (question 8).
- `--yolo`, `HERMES_YOLO_MODE=1` and `trust: full` (question 10).

H8x answers two questions in one run, to stay under the cap. The first `rm` prompts (H9a, H9b) were a probe defect, and the relative paths of H10a, A11a and A11b turned out to be hardline-blocked. That spent five runs on the guard instead of the approval path, which is why the absolute-path runs H9c, A11c and H8x exist.

## User configuration

- `~/.hermes/config.yaml`: `sha256Before` `352f3213...` (the first record, 15:35 CST) and `sha256After` `76642bb9...` (the last record). The file changed between run D2k (15:51) and run H2 (16:52) (`changedBetweenRuns` in `results.json`). That is the hour in which the owner configured the `nous` provider and answered the question. No probe run changed it (`changedBy: []`), and every run's `before` equals its `after`.
- `~/.hermes/.env`: absent through D2k, present from H2 on (`changed: true`, the same window, `changedBy: []`). Only its hash was taken, never its contents.
- `P0-preflight` ran inside that window and records no hashes. Both files were last modified at 16:47 CST (`stat`), before it started at 16:50, so it did not change them either.
- The probe never wrote under `~/.hermes`. Every child ran with `HOME` and `HERMES_HOME` under `<scratch>`. The probe read `~/.hermes/config.yaml` only to hash it, and copied `.env` and `auth.json` into scratch homes.
- Outside the scratch directory hermes writes under the real temporary directory: the gateway's control socket (`<tmpdir>/hermes-gw-<hash>/control.sock`, `acp/A0-1.logs.txt`) and the terminal tool's shell snapshot (`<tmpdir>/hermes-snap-<hash>.sh`, in the `bash -c` command lines of `headless/H2.ps.json`).
- The fake token was searched for after each run in the scratch home and the worktree (`tokenFoundIn` in each record). Headless, it is in the scratch `config.yaml`, where the probe put it, and in the copy hermes makes of it, `backups/config/config.yaml.good.<time>`. It was never found in `state.db`, the logs or the worktree. Over ACP it was found nowhere.

## Answers

### Q1. Version, `hermes acp --check`, provider and model: yes

- **Version:** `hermes --version` printed `Hermes Agent vunknown (2026.9.24)`. The Homebrew keg is hermes-agent 0.22.4_1.
- **ACP:** `hermes acp --check` exited 0 with `Hermes ACP check OK`.
- **Provider and model:** `nous` and `qwen/qwen4-max:free`, named by the owner and configured as the default in `~/.hermes/config.yaml`. The preflight prompt under a scratch home with the copied `.env` and `auth.json` answered `ok` (exit 0). Its usage file shows 1 API call, plus 1 auxiliary `title_generation` call.

Command: `node test/fixtures/hermes/probe.mjs --preflight --provider nous --model qwen/qwen4-max:free`. Evidence: `headless/preflight.txt`, `headless/preflight.json`, `headless/preflight-first.txt`, `headless/P0-preflight.out`, `headless/P0-preflight.usage.json`.

### Q2. Where the work runs: yes

**Headless one-shot**, from `headless/H2.ps.json`: `hermes -z` with the shim. The prompt asks for a heartbeat, `sleep 15 && pwd`, and `done`; the run exited 0 after 82 s. In the listing, 17852 is the probe's own group; the two `in: hermes` rows of the owner's gateway are left out.

```
during the turn (sample at 53.3 s, while the sleep ran)
18391 Python ppid 18001(probe) pgid 18391  hermes -z ...                                          (the started process)
18431 Python ppid 18391        pgid 18431  -m hermes_cli.main --profile default gateway run --quiet --idle-exit
20292 node   ppid 18431        pgid 20292  recording-shim                                         (from 2.2 s)
20306 Python ppid 18431        pgid 20306  tools/mcp_death_supervisor.py --parent-pgid 18431      (from 2.2 s)
52026 bash   ppid 18431        pgid 52026  bash -c source <tmpdir>/hermes-snap-....sh ...         (the terminal tool)
52097 sleep  ppid 52026        pgid 52026  sleep 15

after hermes -z exited (the listing 1.5 s after the exit)
18431 Python ppid 1            pgid 18431  gateway run --idle-exit     (leftAfterExit)
20292 node   ppid 18431        pgid 20292  recording-shim              (leftAfterExit)
20306 Python ppid 18431        pgid 20306  mcp_death_supervisor        (leftAfterExit)
```

- **Who starts the shim:** the gateway (`shim/H2.jsonl`: parent 18431, its own group, cwd `<scratch>/home`).
- **Who runs the shell commands:** the gateway, as `bash -c` in a group of its own. Its working directory is the worktree: H3b's `pwd` printed `<scratch>/wt`.
- **Left after the exit:** the gateway, the shim and the supervisor. The probe ended them (`records/H2.json` `orphans`).

**ACP**, from `acp/A2.ps.json`: the client (`node` 91508) starts `hermes acp`; same prompt, `end_turn` after 62 s.

```
during the turn (sample at 12.2 s)
91508 node   ppid 91058(probe) pgid 91508  acp-client.local.mjs
91551 Python ppid 91508        pgid 91508  hermes acp
92734 Python ppid 91551        pgid 92734  gateway run --quiet --idle-exit
94140 node   ppid 92734        pgid 94140  recording-shim (the turn's)
94155 Python ppid 92734        pgid 94155  mcp_death_supervisor --parent-pgid 92734
 1116 bash   ppid 92734        pgid 1116   bash -c ... (the terminal tool)
 1117 sleep  ppid 1116         pgid 1116   sleep 15

after the client exited
92734 Python ppid 1            pgid 92734  gateway run --idle-exit     (leftAfterExit)
```

- Over ACP the shim's cwd is `session/new.cwd`, the worktree (`shim/A2.jsonl`). The gateway started a discovery shim at `session/new` and the turn's shim 1.6 s later.
- The command ran in `<scratch>/wt` (`acp/A2.frames.jsonl`).
- When the client closed `hermes acp`'s stdin, the turn's shim and supervisor ended with the session. The gateway stayed, with ppid 1 and a 600 s idle exit.

**A gateway, shared.** Every run started one gateway per scratch home. A second client on the same home attaches to the running gateway and starts none (`acp/A0-2.ps.json`, `headless/D16-2.ps.json`). Headless, it even reuses the first run's shim, started with the first run's environment (`shim/D16-1.jsonl`, one start for two runs).

**Killing the started process group** (H2k, A2k: SIGTERM to `-pid` once `sleep 120` was seen). It stopped neither the shell command nor the shim:

- Headless (`headless/H2k.ps.json` `leftAfterExit`): the gateway, the shim, the supervisor, the `bash` and `sleep 120` were all still alive. The probe ended them (`records/H2k.json` `orphans`).
- ACP (`acp/A2k.ps.json`): the same five were left after the client and `hermes acp` died.

Commands: `node test/fixtures/hermes/probe.mjs --run H2 --provider nous --model qwen/qwen4-max:free`, and the same with `--run H2k`, `--run A2` and `--run A2k`; `--run A0`, `--run D16`. Evidence: `headless/H2.ps.json`, `shim/H2.jsonl`, `records/H2.json`, `headless/H2k.ps.json`, `records/H2k.json`, `acp/A2.ps.json`, `acp/A2.frames.jsonl`, `shim/A2.jsonl`, `acp/A2k.ps.json`, `records/A2k.json`, `acp/A0-2.ps.json`, `headless/D16-2.ps.json`.

### Q3. A 30 KB brief, the directory, ending on its own, exit codes: partly

- **The form:** `hermes chat --query-file <path> --oneshot --format stream-json --max-turns 12` took a 30,079-byte brief from a file. Only the path is on the command line. `-z` takes its prompt only as an argument (`headless/N0-help.out`).
  - H3 worked in the worktree it was started in, made the commit and reported (Q12).
  - The free model was slow, and the run was still writing its last reply when the probe's 300 s limit ended it (`records/H3.json`, `exit.signal` SIGTERM). So the 30 KB form was not seen to end on its own.
  - Every shorter `chat -q` and `-z` run ended on its own.
- **The directory:** commands ran in the started directory, `<scratch>/wt` (`headless/H3b.out`, `pwd`).
- **Exit codes:**
  - success: 0 from `-z` (H2) and from `chat` (H7, H9c);
  - failure: 2 from `-z` (an unknown model, H13; a provider error, D2), and 1 from `chat` (a provider error, D3; no provider, C0-chat);
  - a reached iteration limit: 1 from `chat --max-turns 1`, with the `result` text `I ran out of steps for this turn (1 tool calls) before finishing` (H3b).

Commands: `--run H3`, `--run H3b`, `--run H2`, `--run H7`, `--run H13` (each with `--provider nous --model qwen/qwen4-max:free`), `--run D3`, `--run C0`, `--run N0`. Evidence: `records/H3.json`, `headless/H3.out`, `records/H3b.json`, `headless/H3b.out`, `headless/H7.out`, `headless/H13.out`, `headless/D3.out`, `headless/C0-chat.out`, `headless/N0-help.out`.

### Q4. A per-launch `HERMES_HOME` with `mcp_servers.orchestrator`: yes

A scratch `HERMES_HOME` under `<scratch>/home`, whose `config.yaml` holds `mcp_servers.orchestrator`:

- gave each run its own shim, started by that home's gateway (`shim/H2.jsonl`);
- found the credential in the copied `.env` and `auth.json` (`headless/H2.usage.json`: provider `nous`, `completed: true`);
- left `~/.hermes/config.yaml` with the same hash before and after every run (User configuration).

Hermes copies the scratch `config.yaml`, fake token included, to `backups/config/config.yaml.good.<time>` in the same scratch home (`records/H2.json` `tokenFoundIn`).

Commands: `--run H2`, `--run H3`, `--run N1`. Evidence: `records/H2.json`, `shim/H2.jsonl`, `headless/H2.usage.json`, `records/H3.json`, `headless/N1-mcp-test.out`, `shim/N1-mcp-test.jsonl`.

### Q5. ACP `initialize`, and servers named on `session/new`: yes

- **`initialize`:** it answers `protocolVersion: 1`, `agentInfo` `hermes-agent` `0.0.0`, and the capabilities `loadSession`, `promptCapabilities.image` and `sessionCapabilities` fork, list and resume. It offers one auth method, `hermes-setup` of type `terminal` (`hermes acp --setup`).
- **A server named on `session/new`:**
  - It is started by the gateway daemon, not by `hermes acp`, with `session/new.cwd` as its cwd.
  - During `session/new` the gateway runs discovery on it and closes it. During a turn it starts the server again (`shim/A2.jsonl`, two starts).
  - It is registered as `editor_orchestrator_<8 hex>`.
- **A second session:** a second `session/new` in the same process got a shim process of its own (`shim/A0-1-second.jsonl`, the same gateway parent).

Commands: `--run A0`, `--run A2`. Evidence: `acp/A0-1.client.jsonl`, `acp/A0-1.frames.jsonl`, `shim/A0-1.jsonl`, `shim/A0-1-second.jsonl`, `acp/A0-1.logs.txt`, `shim/A2.jsonl`, `acp/A2.ps.json`.

### Q6. What the shim's process receives, and the tool names: yes

- **Environment:** the shim gets only the entry's `env` plus `HOME`, `LANG`, `PATH`, `TMPDIR`, `USER` and `__CF_USER_TEXT_ENCODING`. It does not get `HERMES_HOME`, `PROBE_MARKER=from-client-env` or any other variable of the client. So `ORCH_*` must be listed in the entry's `env` or read with `--orch-env-file`; both worked (`shim/H2.jsonl`, `shim/A2.jsonl`, `shim/N1-mcp-test-envfile.jsonl`).
- **Tool names headless:** `mcp__orchestrator__heartbeat`, `mcp__orchestrator__report`, `mcp__orchestrator__block`, `mcp__orchestrator__inbox` and `mcp__orchestrator__log`. They use double underscores, not the documented `mcp_<server>_<tool>`.
- **Tool names over ACP:** `mcp__editor_orchestrator_<8 hex>__<tool>` (`acp/A2.frames.jsonl`).
- **How the model reaches them:** Hermes loads tool schemas lazily. The model first called `tool_describe` or `tool_search`, then the MCP tool (`headless/H3.out`, `headless/H10b.out`).

Commands: `--run H2`, `--run H3`, `--run A2`, `--run N1`. Evidence: `shim/H2.jsonl`, `shim/A2.jsonl`, `headless/H3.out`, `acp/A2.frames.jsonl`, `shim/N1-mcp-test.jsonl`, `shim/N1-mcp-test-envfile.jsonl`.

### Q7. A shim that cannot start: yes

A shim command that exits 1 does not stop a run, and nothing in the output says so.

- **Headless (H7):**
  - The gateway started the shim four times. It logged `registered 0 tool(s) ... 1 failed: orchestrator` (`headless/H7.logs.txt`).
  - The model, asked to call the heartbeat "if you have it", searched for it, found nothing and answered `done`.
  - `chat` exited 0, and its `stream-json` holds no line about the server (`headless/H7.out`).
- **Over ACP (A0-bad):** `session/new` succeeds. Only the gateway log says `Editor MCP server 'orchestrator' failed discovery; session ... continues without it` (`acp/A0-bad.logs.txt`).

Commands: `--run H7`, `--run A0`, `--run D7`. Evidence: `headless/H7.out`, `headless/H7.logs.txt`, `shim/H7.jsonl`, `records/H7.json`, `acp/A0-bad.client.jsonl`, `acp/A0-bad.logs.txt`.

### Q8. The limit of an MCP tool call: partly

- **The default:** 300 s, in both forms. A `block` answered after 310 s was cut, with `MCP call failed: TimeoutError: MCP call timed out after 300.0s (configured timeout: 300.0s)` as the tool result (H8a headless, A8a over ACP). The model got the error and the turn ended normally (exit 0, `end_turn`).
- **A 200 s block:** it is not cut, since the limit is 300 s. A 200 s block was not run.
- **`timeout` on the entry:** `timeout: 430` on `mcp_servers.orchestrator` lifted the limit. The 310 s answer came back (`duration_ms: 310047`) and the model repeated it (H8x).
- **Over ACP:** a server named on `session/new` has no timeout field, and it was cut at 300 s (A8a). The installed source sets an editor server's limit from `timeouts.mcp.tool_call` in the home's `config.yaml`, else 300 s (`tools/mcp_tool_common.py` `_resolve_tool_timeout`, `gateway/session_local_mcp.py` `_configs`). A per-launch `HERMES_HOME` could carry that key. This was not run: A8b was dropped at the run cap.

Commands: `--run H8a`, `--run H8x`, `--run A8a`. Evidence: `headless/H8a.out`, `headless/H8a.logs.txt`, `shim/H8a.jsonl`, `headless/H8x.out`, `shim/H8x.jsonl`, `records/H8x.json`, `acp/A8a.frames.jsonl`, `acp/A8a.logs.txt`, `shim/A8a.jsonl`.

### Q9. Headless approvals: partly

- **The shim's tools:** called without any approval under the default `trust` (H2, H3, H8a).
- **A dangerous command under `chat -q`** (H9c, `rm -r <absolute path in the worktree>`, default approvals):
  - It was refused at once, with no wait: `BLOCKED: Command flagged as dangerous (delete in root path) but single-query mode (-q) runs without a user present to approve it. ... set approvals.single_query_mode: approve in config.yaml.`
  - The model got that text and tried a Python fallback through `execute_code`, which was blocked the same way, then a relative path.
  - The run went on and exited 0. The directory was left in place.
- **The hardline guard on relative paths.** Every relative `rm -r ./probe-rm-target` was blocked as `recursive/any delete of this Hermes runtime's own virtualenv`. It is "on the unconditional blocklist ... not even with --yolo, /yolo, approvals.mode=off" (H9a, H9b, H10a, H9c's third try, A11a, A11b).
  - The guard (`agent/runtime_self_protection.py`) `realpath`s the argument against the gateway's own working directory, not the terminal's.
  - The gateway's working directory is `/opt/homebrew/Cellar/hermes-agent/0.22.4_1/libexec/lib/python3.14/site-packages` (`headless/gateway-cwd.txt`), inside the protected virtualenv.
  - So a relative delete can never run through this agent, even with a `workdir` argument (H9c).
- **Under `-z`:** H9b's command was the defective `rm -r ./probe-rm-target .`, which only met the hardline guard. A dangerous command that the guard lets through was not run under `-z`.
- **`smart` mode:** no auxiliary approval call was seen. H9b's usage file shows `auxiliary.api_calls: 0`, and H9c's log has no approval-judge call: `-q` blocks before any judgement.

Commands: `--run H9c`, `--run H9a`, `--run H9b`, `--run H10a`, `--run H2`. Evidence: `headless/H9c.out`, `headless/H9c.logs.txt`, `records/H9c.json`, `headless/H9a.out`, `headless/H9b.out`, `headless/H9b.usage.json`, `headless/H9b.logs.txt`, `headless/H10a.out`, `headless/gateway-cwd.txt`, `shim/H2.jsonl`. Blocked part: `-z` with an absolute path, for want of runs (run cap).

### Q10. Removing every wait on a human, and a per-launch ruleset: partly

- **`approvals.mode: off` in the per-launch `config.yaml`** (H8x):
  - Under `chat -q` the absolute `rm -r` ran (`exit_code: 0`, `rmTargetAfter: removed`), with no prompt and no refusal.
  - The scratch `config.yaml` kept its hash (`scratchConfigSha256Before` = `After` in `records/H8x.json`). Hermes did write a copy of it under `backups/config/`.
  - It does not lift the hardline guard (H10a).
- **A per-launch ruleset** (H10b: `--toolsets file,mcp-orchestrator`, and `tools.include: [heartbeat, report, block, inbox]` on the entry):
  - The terminal tool and the `log` tool were gone from the model's tools. `tool_search` found 4 orchestrator tools.
  - The model reported both as missing. A tool outside the set is not offered, rather than refused with an error.
- **Not run (run cap):** `--yolo`, `HERMES_YOLO_MODE=1`, `trust: full`, `command_allowlist`, and the `approvals.single_query_mode: approve` key that the H9c refusal names.

Commands: `--run H8x`, `--run H10b`, `--run H10a`. Evidence: `headless/H8x.out`, `records/H8x.json`, `headless/H10b.out`, `records/H10b.json`, `shim/H10b.jsonl`, `headless/H10a.out`, `records/H10a.json`.

### Q11. ACP permission requests: partly

- **What asks:** the absolute `rm -r` arrived as `session/request_permission` (A11c, 41 s into the turn). The heartbeat, the `block` call and `sleep 15 && pwd` asked nothing (A2, A8a).
- **The options:** `allow_once` (Allow once), `allow_session` (kind `allow_always`, Allow for session), `allow_always`, `deny` (kind `reject_once`) and `deny_always` (kind `reject_always`). The client never answers an `*_always` option.
- **The fields naming the command:** `toolCall.rawInput.command`, `toolCall.rawInput.description` (`delete in root path`), `toolCall.title` (`delete in root path: rm -r ...`) and the content text. `toolCall.toolCallId` is `perm-check-1`, not the tool call's own id.
- **After a reject (`deny`):**
  - The tool call was updated `failed`, and the model got `BLOCKED: Command denied by user. ... Do NOT retry this command ...`.
  - The turn went on and ended with `end_turn` 34 s later. The directory was left in place.
- **No answer with `approvals.timeout: 30`:** not observed. A11b's relative path was hardline-blocked before any request, and A11d (an absolute path) was dropped at the run cap.

Commands: `--run A11c`, `--run A11b`, `--run A2`. Evidence: `acp/A11c.frames.jsonl`, `acp/A11c.client.jsonl`, `records/A11c.json`, `acp/A11b.frames.jsonl`, `acp/A2.frames.jsonl`.

### Q12. A commit on the launch branch in a linked worktree: yes

With the `local` terminal backend, headless, the agent wrote `greeting.txt` and ran `git add greeting.txt && git commit -m "probe: greeting"` in the linked worktree. The result was commit `a6b8aa2` on `task/PROBE/l1`, with a clean status afterwards and `main` unchanged (`records/H3.json` `git`). A commit over ACP was not tried.

Command: `--run H3`. Evidence: `records/H3.json`, `headless/H3.out`.

### Q13. Model and effort: yes

- **`-m` and `--provider`:** they take effect. The `stream-json` `system` line names `qwen/qwen4-max:free`, and the usage file names that model and provider `nous` (`headless/H2.usage.json`).
- **Model names:** `qwen/qwen4-max:free` has a slash and a colon. It fails `MODEL_PATTERN` (`src/runner/selection.ts:75`) and fits `OPENCODE_MODEL_PATTERN` (`:78`).
- **An unknown model** (`-z -m probe-no-such-model-9`, H13):
  - exit 2;
  - on stdout: `Model 'probe-no-such-model-9' isn't available on Nous Portal.` and `Provider said: HTTP 404: ...`;
  - a usage file with `failed: true` and `provider: null`.
- **Effort:** `--reasoning none|minimal|low|medium|high|xhigh|max|ultra` (`headless/N0-chat-help.out`).
- **Over ACP:**
  - Model ids are `<provider>:<model>`.
  - `session/set_model` with an unknown id is refused, -32603 `model_resolution_failed`.
  - `session/set_config_option` for `model` or `effort` answers `{configOptions: []}` and changes nothing (`acp/A0-1.client.jsonl`).
  - The model of an ACP session comes from the home's `config.yaml` (`acp/A2.logs.txt`, `model=qwen/qwen4-max:free provider=nous`).

Commands: `--run H13`, `--run H2`, `--run N0`, `--run A0`. Evidence: `headless/H13.out`, `headless/H13.usage.json`, `records/H13.json`, `headless/H2.usage.json`, `headless/H3.out`, `headless/N0-chat-help.out`, `acp/A0-1.client.jsonl`.

### Q14. Usage: yes

- **`--usage-file`** (`-z` only; `headless/H2.usage.json`, `headless/P0-preflight.usage.json`):
  - It holds `estimated_cost_usd`, `cost_status` (`estimated`) and `cost_source` (`provider_models_api`). So the cost is an estimate from the provider's price list, here 0 for a free model.
  - It holds `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `total_tokens`, `api_calls`, `model`, `provider` and `session_id`.
  - It holds the outcome: `completed`, `partial`, `interrupted`, `failed`, `turn_exit_reason` and `service_tier`.
  - Auxiliary calls are in an `auxiliary` block, broken down `by_task` (P0: one `title_generation` call). They are left out of the main totals and added in `total_including_auxiliary` (P0: 13,245 tokens without, 13,368 with).
- **`stream-json` `result`** (`chat`): it holds `session_id`, `exit_code`, `text`, `tokens` (`input`, `output`, `total`, `cache_read`, `cache_write`) and `duration_ms`. There is no cost and no API-call count.
- **Cache in the input:** `tokens.input` includes the cache reads and writes. In H7, input 26,491 = cache_read 24,352 + cache_write 2,126 + 13. The usage file counts the same way (H9b: 26,793 = 24,350 + 2,430 + 13).
- **ACP:** the `session/prompt` result carries `usage` with `inputTokens` (without the cache, 20 in A2), `cachedReadTokens`, `outputTokens`, `thoughtTokens` and `totalTokens`. There is no cost (`acp/A2.client.jsonl`).

Commands: `--run H2`, `--preflight`, `--run H7`, `--run A2`. Evidence: `headless/H2.usage.json`, `headless/P0-preflight.usage.json`, `headless/H9b.usage.json`, `headless/H7.out`, `acp/A2.client.jsonl`.

### Q15. Failures: yes

| Case | Headless | ACP |
|---|---|---|
| No credential | `-z` and `chat` exit 1, `It looks like Hermes isn't configured yet -- no API keys or providers found.`, `stream-json` `error: "credentials or agent init failed"` (C0) | `session/new` -32603 `storage_unavailable` with no model; `session/prompt` -32603 `admitted_turn_failed` with no key (C0-acp-nomodel, C0-acp) |
| Unknown model | `-z` exit 2, `Model '...' isn't available on Nous Portal` and the provider's 404 (H13) | `session/set_model` -32603 `model_resolution_failed` (A0-1) |
| Shim did not start | nothing in the output, exit 0; only the gateway log (H7) | `session/new` succeeds; only the gateway log (A0-bad) |
| Denied command | the `BLOCKED: ...` text goes to the model, `chat -q` exits 0 (H9c) | a `tool_call_update` with `status: failed` and the `BLOCKED: Command denied by user` text, then `end_turn` (A11c) |
| Iteration limit | `chat` exits 1, `result.text` `I ran out of steps for this turn` (H3b) | not run |

Commands: `--run C0`, `--run H13`, `--run H7`, `--run H9c`, `--run A11c`, `--run H3b`, `--run A0`. Evidence: `headless/C0-z.out`, `headless/C0-chat.out`, `acp/C0-acp-nomodel.client.jsonl`, `acp/C0-acp.client.jsonl`, `headless/H13.out`, `acp/A0-1.client.jsonl`, `headless/H7.out`, `headless/H9c.out`, `acp/A11c.frames.jsonl`, `headless/H3b.out`.

### Q16. Isolation and process behaviour: partly

- **Writes to the home.** A turn writes into its `HERMES_HOME` (`records/H2.json` `homeFiles`):
  - `SOUL.md`, `.skills_prompt_snapshot.json` and about 330 bundled skill files;
  - `state.db`, `kanban.db` and `projects.db`;
  - `cron/`, `gateway.pid`, `gateway.lock`, `gateway_state.json` and `runtime/`;
  - caches and logs;
  - `plugin-update-checks/` and `source-checks/` (the gateway runs `pip --version` and `xcodebuild -license check` as helpers, `headless/H3.ps.json`, `headless/H3b.ps.json`);
  - `backups/config/config.yaml.good.<time>`.
- **Writes to the worktree.** Only what the task asked: the H3 commit, and nothing in any other run (`git.status` empty, except the `rm` targets the probe created).
- **Two runs on one home.** Two no-key `chat -q` runs at once both ended, sharing one gateway and one shim (D16). Two model runs on one home (H16) were not run.
- **Stream-json gaps.** `chat` prints a line per tool call and result, and text in small pieces. The longest gap in a working turn was 59 s (H3, model time). While a `block` waited it was 300 s (H8a) and 310 s (H8x) (`stdoutLines.maxGapMs` in the records).
- **SIGTERM to the process group** (H2k headless, A2k ACP): it ended only the started process. The gateway, the shim, the supervisor, the `bash` and its `sleep 120` were all left, and the probe ended them (`orphans`).
- **Not run (run cap):** what a turn reads from the home (memory, `SOUL.md`, skills, plugins, `AGENTS.md`), and which switch turns each off.

Commands: `--run H2k`, `--run A2k`, `--run H3`, `--run H2`, `--run D16`. Evidence: `records/H2k.json`, `headless/H2k.ps.json`, `records/A2k.json`, `acp/A2k.ps.json`, `records/H3.json`, `records/H2.json`, `records/H8a.json`, `records/D16-1.json`, `records/D16-2.json`, `shim/D16-1.jsonl`.

## For the decision record

The twelve criteria of `test/fixtures/acp/README.md`. Each cell is `pass`, `fail`, `partly` or `not probed`, with the question (Q) it rests on. Since 2026-11-20 the grading rule of the decision record (`openspec/changes/archive/2026-11-20-harness-integration-shape/design.md`, section 2) governs this table: a workaround counts only when this probe ran it, and a gap that was not probed grades `partly`. The cells the review named were graded again by it; the other `pass` cells were not re-examined (the record's open question 24). One cell was graded again by it, `hermes headless` C9, and the C7 cells say which part has no workaround run.

| Criterion | `hermes headless` | `hermes acp` |
|---|---|---|
| C1 Registration | pass: `mcp_servers.orchestrator` in a per-launch `HERMES_HOME/config.yaml` gives the run its own server, and `~/.hermes` is untouched; the token also lands in that home's `backups/config/` (Q4) | pass: per session in `session/new.mcpServers`, started by the gateway as `editor_orchestrator_<hash>` with the session's cwd; the token was found nowhere in the home (Q5) |
| C2 Required | fail: no `required` analog; a run without its shim goes on, exit 0, and only the gateway log says so (Q7) | fail: `session/new` succeeds without the server, and only the gateway log says so (Q7) |
| C3 No human | pass with `approvals.mode: off` in the per-launch config: the dangerous command ran with no wait (H8x); without it `chat -q` refuses at once and goes on (H9c). The hardline guard refuses every relative `rm` whatever the mode (Q9, Q10) | partly: a dangerous command waits on `session/request_permission`; a `deny` comes back to the model and the turn goes on; the unanswered timeout was not probed (Q11) |
| C4 Rules | partly: `--toolsets` and `tools.include` remove tools from the model's list rather than refuse them; `command_allowlist` was not probed (Q10) | not probed: only the permission options were seen (Q11) |
| C5 Timeout | pass: the default is 300 s, and `timeout` on the entry lifted it for a 310 s `block` (Q8) | partly: cut at 300 s; the source reads `timeouts.mcp.tool_call` from the home's config, not run (Q8) |
| C6 Commit | pass: `a6b8aa2` on `task/PROBE/l1` in the linked worktree (Q12) | not probed (Q12) |
| C7 Selection | partly: `--provider`/`-m` take effect (`headless/H2.usage.json`), but `<vendor>/<model>:<tag>` names fail `MODEL_PATTERN`; `--reasoning` is the effort flag in `--help` (`headless/N0-chat-help.out`) and no run used it, so no effort setting was shown to apply (Q13) | partly: the model comes from the home's config (`acp/A2.logs.txt`); `set_model` takes `<provider>:<model>` ids and refuses an unknown one, but was run only with an unknown id; `set_config_option` for `model` or `effort` is silently empty, so no effort setter was run (Q13, `acp/A0-1.frames.jsonl`) |
| C8 Usage | pass: `--usage-file` has tokens, `api_calls`, an estimated cost and the auxiliary calls; `stream-json` has tokens (input including cache) and `duration_ms` (Q14) | partly: tokens per prompt (input without cache, cached reads, output, thought, total); no cost (Q14) |
| C9 Failures | partly (regraded 2026-11-20): distinct exit codes (1 no provider, 2 `-z` failure, 1 iteration limit) and texts on stdout, but a failed shim shows only in the gateway log, not in the output or the exit code (Q15, Q3, Q7, `headless/H7.out`) | partly: -32603 with `data.details` (`storage_unavailable`, `admitted_turn_failed`, `model_resolution_failed`); a denial as a failed tool call; a failed shim only in logs (Q15) |
| C10 Isolation | partly: one `HERMES_HOME` per launch holds config, credentials, state and its own gateway, and the shim gets only listed variables; two runs on one home share the gateway and the first run's shim, so a home cannot be shared between launches; the reads were not probed (Q4, Q6, Q16) | partly: the gateway is per home, so isolation needs one `HERMES_HOME` per launch, and a second client joins the first one's gateway (Q2, Q16) |
| C11 Process | fail: the gateway, which runs the shell commands and the shim, lives in groups of its own and outlives the started process; SIGTERM to the group left the gateway, the shim, the supervisor and a running `sleep 120` (Q2, Q16) | fail: the same; the gateway (ppid 1, 600 s idle exit) runs the commands, and A2k left the gateway, the shim, the supervisor and `sleep 120` after the client's group was signalled (Q2, Q16) |
| C12 Stability and residue | partly: `stream-json`, the usage file and the exit codes are documented but not versioned; per harness: the gateway lifecycle, a `HERMES_HOME` per launch, the `mcp__<server>__<tool>` names, the hardline guard and the failure texts (Q2, Q3, Q6, Q9, Q14) | partly: ACP version 1; per harness: the gateway lifecycle, a `HERMES_HOME` per launch, the `<provider>:<model>` ids, the `editor_<name>_<hash>` tool names and the `data.details` codes (Q2, Q5, Q13, Q15) |
