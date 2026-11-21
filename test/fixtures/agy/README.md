# Probe of `agy` 1.5.13 (`agy --version`, /opt/homebrew/bin/agy), model `gemini-3.8-flash-low`, credential: cached sign-in, 2026-11-20

This probe (GH-198) asks whether the Antigravity CLI (`agy`) can serve as a worker harness, driven headless (`agy -p`) and over the Agent Client Protocol (`agy acp`, with the client of GH-197). Each of the sixteen questions of the issue is answered below from a run's frames, exit codes, files and processes, with the command and the evidence file. Nothing under `src/` changed.

## Files

- `probe.mjs`: the probe. `--preflight [--model <slug>]` prints one `ok:`/`missing:` line per prerequisite; `--run <ids> --model <slug>` runs those runs and writes their evidence and `records/<run>.json` as soon as each ends; `--assemble` rebuilds `results.json` from `records/` and `answers.json`; `--check` checks `results.json` and its evidence, needs no model and no `agy`, and prints `agy probe: N of 16 questions recorded`. `--bin` (default `agy`) points it at another binary.
- `answers.json`: the answers, written by hand from the evidence, with the header and the user configuration hashes. `results.json` is assembled from it and the records.
- `userconfig-before.json`: the hashes of the three named files before the first run.
- `headless/`: per headless run `<run>.stdout.txt`, `<run>.stderr.txt`, `<run>.log<n>.txt` (agy's logs written during the run, redacted) and `<run>.mcp_config.json` (the per-launch MCP file); `preflight*.txt|json`; `attempts/` for the first stream-json guess.
- `acp/`: per ACP run `<run>.frames.jsonl` (every frame, both directions), `<run>.client.jsonl` (the client's stdout), `<run>.stderr.txt` and `<run>.log<n>.txt`.
- `shim/`: per run, the recording shim's file (start record with argv, cwd, environment names and the ORCH_*/marker values, requests, calls).
- `records/`: one record per run: command, environment (values only for ORCH_*, PROBE_MARKER, HOME and AGY_*), exit, time, `modelCalls`, `orphans`, the process listing, where the fake token was found, `git status --porcelain` and `--porcelain --ignored` of the worktree, the three named files that changed and what changed under `~/.gemini`.

The ACP client and the shim are GH-197's, used read only: `../acp/acp-client.mjs` and `../acp/recording-shim.mjs`. The client's `--requests-json` carried `session/set_model` (every ACP model run set `gemini-3.8-flash-low`, as the default is `gemini-4-neon-high`) and the `authenticate` and unknown-model requests, so no local copy of the client was needed.

## How the runs were made

- **Prerequisites.** The first preflight found `agy` 1.5.13 on `PATH` but no sign-in. The task asked the owner once (`block`, needsAccess); the owner signed in interactively and answered `ready gemini-3.8-flash-low`. `GEMINI_API_KEY` was not set for the worker, so every question that needs a scratch `HOME` with a credential is answered from the runs that show the cached sign-in missing there (H3-home, A0-home).
- **Scratch.** Every run made a directory with `mkdtemp` under the real path of `os.tmpdir()`, outside this repository, removed in an exit handler. It held `repo` (one commit, `.orchestrator/` in `info/exclude`, the fixture identity), `wt` (a linked worktree on `task/PROBE/l1`, always the harness's working directory), `home` (a scratch HOME when a run needs one, and the per-launch `--add-dir` directory `home/launch`) and `out` (the shim's file, the client's files). The script's own git ran with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and the fixture identity.
- **Environment.** Every child got `PATH`, `HOME` (the user's, or `<scratch>/home`), `USER`, `LANG`, `TMPDIR`, the fake `ORCH_LAUNCH_ID=probe-launch`, `ORCH_TOKEN=orch-probe-token-<8 hex>` (one per run), `ORCH_API=http://127.0.0.1:9`, and `PROBE_MARKER` (`from-agy-env` headless, `from-agent-env` over ACP). The shim's entry carried the same ORCH_* values and `PROBE_MARKER=from-entry-env`. Nothing of the worker's own environment was passed on.
- **Processes.** Every CLI (and the ACP client) started detached, leading its own process group, under a hard limit; at the limit only that group was signalled. The script sampled the process tree and group every 500 ms; after each run every process it had seen that was still alive was killed and named in `orphans`. No run had one. A saved listing holds the run's own tree (`in: tree`) and rows whose command is the harness (`in: harness`), nothing else.
- **Cost.** Only `gemini-3.8-flash-low` was named (H13-effort used its base name `gemini-3.8-flash` with `--effort low`). 20 runs called a model, the cap: P2-preflight, H2-stdin-json, H4a, H4b, H7, H8a, H8b, H9, H9b, H10a, H10b, H12a, H12b, H13-effort, H15, A1, A7, A8, A8b, A11. Runs that stopped before a model call (flag errors, no credential, an unknown model) have `modelCalls: 0`. Headless runs used `--print-timeout 180s`, the preflight 60s, H15 10s and the block runs 400s.
- **Redaction**, as `test/fixtures/opencode/README.md` "Redaction" does it, on each decoded JSON string: the scratch directory becomes `<scratch>`, this checkout `<repo>`, the home directory `~`, git identities `Fixture Author` and emails `author@example.invalid`; ANSI sequences are dropped and anything shaped like a Google key or OAuth token becomes `<key>` (none occurred). Model text arrives in small chunks, so a path the model echoes can be split across `step_update` deltas or ACP chunks and keep pieces of the `/private/var/folders` scratch path (H10a, H10b); never the home directory.
- **Deviations, kept in the evidence as they were.**
  - Three runs were started without `--model` and recorded `modelCalls: 0` by hand after the fact: H2-stdin (the stdin attempt), H3-home (no credential under the scratch HOME), and the first registration run, which passed the string `null` as the model and is kept as `H13-nullmodel`, the unknown-model evidence. The script now refuses `--run` without `--model`.
  - H9 put the per-launch directory at `<scratch>/home/launch`; the agent then ran its commands there, so the worktree steps were repeated as H9b with `<scratch>/zz-launch`.
  - Under `--dangerously-skip-permissions` or an allow-all ACP policy, the model of H7 and A7 searched for the missing tools outside the scratch directory: it read this checkout's `test/fixtures/agy/probe.mjs`, `test/fixtures/acp/*.mjs`, agy's own logs and the transcripts of earlier probe conversations under `~/.gemini/antigravity-cli/brain/`. Every command it ran was a read, and it changed nothing (every hash and the checkout were unchanged). That is why its transcripts hold the fake token (see the records' `tokenFoundIn`).
  - After the runs, `node probe.mjs --scrub` applied two redactions added then to every evidence file: the local user name becomes `<user>`, and a string holding a process listing (H7's `ps aux | grep -i orchestrator` output, the whole process table) becomes `<removed: ...>`.
- **The scrub of 2026-11-20.** Host data that the redaction above missed was removed from the committed evidence on 2026-11-20, and #208 re-scrubbed every evidence file with `node probe.mjs --scrub`. It removed the shell `PATH` (a whole list, also one cut from its name, as in `acp/A7-badshim.frames.jsonl`), the Antigravity project id (in `ANTIGRAVITY_PROJECT_ID=`, `project ID:` in agy's logs, `config/projects/<id>.json` and `project "..." (id=...)`, and wherever an id seen there appears again), the values of environment listings, and the temporary root. The placeholders the scrub and the probe use are `user` (the user name, from a hand scrub; it occurs in the Hermes evidence, not here), `<user>` (the user name as a whole word), `<PATH>` (a shell `PATH` list), `<project>` (the project id), `<tmpdir>` (the real path of `os.tmpdir()`) and `<value>` (a value in an environment listing, outside `ORCH_*`, `PROBE_MARKER`, `HOME`, `PWD`, `LANG`, `TERM` and `SHLVL`). Since #208 the probe redacts all of these itself when it writes evidence, and `node probe.mjs --check` fails when a file still holds host data.

## Runs

| Run | What | Model calls | Exit | Seconds |
|---|---|---|---|---|
| A0-auth-key | `authenticate` with `gemini-api-key` and no key, then `session/new` | 0 | 0 | 1.3 |
| A0-gemdir | the same with `agy acp --gemini-dir <scratch>/home/gem`, after the sign-in: session created | 0 | 0 | 1.2 |
| A0-home | the same under a scratch HOME (after the sign-in): `Authentication required` | 0 | 4 | 0.3 |
| A0-init | ACP `initialize` and `session/new` with the shim, before the sign-in | 0 | 4 | 0.4 |
| A0-session | `session/new` options; `set_config_option` and `set_model` with an unknown model | 0 | 0 | 1.0 |
| A1-shim | ACP, shim in `mcpServers`, heartbeat, `git status` (rejected), a write | 1 | 0 | 3.5 |
| A11-noanswer | ACP, a permission request left unanswered, SIGTERM at 130 s | 1 | 3 | 130.3 |
| A7-badshim | ACP, the shim's command does not exist | 1 | 0 | 51.3 |
| A8-block | ACP, block answered after 200 s | 1 | 0 | 186.1 |
| A8b-block-meta | ACP, as A8 with `timeoutSeconds` and `_meta.timeoutSeconds` on the entry | 1 | 0 | 185.3 |
| H10a-skip | four steps with `--dangerously-skip-permissions` | 1 | 0 | 10.7 |
| H10b-rules | four steps with `--settings` permission rules | 1 | 0 | 11.5 |
| H12a-commit | brief-shaped commit, no sandbox | 1 | 0 | 5.6 |
| H12b-commit-sandbox | brief-shaped commit with `--sandbox` | 1 | 0 | 6.0 |
| H13-effort | `--model gemini-3.8-flash --effort low` | 1 | 0 | 3.2 |
| H13-nullmodel | `--model null` by a probe mistake: the unknown-model evidence | 0 | 1 | 1.7 |
| H15-timeout | `sleep 60` under `--print-timeout 10s` | 1 | 3 | 11.4 |
| H2-stdin-json-try1 | 30 KB as `--input-format stream-json`, wrong shape (headless/attempts/) | 0 | 1 | 1.9 |
| H2-stdin-json | 30 KB as one `stream-json` user message | 1 | 0 | 3.3 |
| H2-stdin | 30 KB on stdin with `-p ''` (empty prompt) | 0 | 1 | 0.6 |
| H3-home | one prompt under a scratch HOME (no credential there) | 0 | 1 | 60.3 |
| H4a-wt | shim in `<wt>/.agents/mcp_config.json`, skip-permissions, call heartbeat | 1 | 0 | 10.3 |
| H4b-adddir | shim in `<scratch>/home/launch/.agents/mcp_config.json` with `--add-dir` | 1 | 0 | 8.4 |
| H7-badshim | headless, the shim's command does not exist | 1 | 0 | 53.8 |
| H8a-block-default | block answered after 200 s, no `timeoutSeconds` (started with H8b and A8) | 1 | 0 | 188.3 |
| H8b-block-300 | block answered after 200 s, `timeoutSeconds: 300` | 1 | 0 | 253.6 |
| H9-norule | no rule: four steps, shim by `--add-dir <scratch>/home/launch` | 1 | 0 | 9.8 |
| H9b-norule-order | as H9 with `--add-dir <scratch>/zz-launch` | 1 | 0 | 4.9 |
| N1-acp-help | `agy acp --help` | 0 | 0 | 0.1 |
| N1-help | `agy --help` | 0 | 0 | 0.4 |
| N1-models | `agy models` (after the sign-in) | 0 | 0 | 1.0 |
| N2-badflag | `-p` with an unknown flag | 0 | 2 | 0.1 |
| N3-noauth-json | `--output-format json` with no credential, `--print-timeout 10s` (cut by the probe at 60 s) | 0 | 1 | 60.2 |
| N4-mcp-help | `agy mcp --help` | 0 | 0 | 0.4 |
| N4-mcp-list-home | `agy mcp list` under a scratch HOME with its own `mcp_config.json` (listed) | 0 | 0 | 0.1 |
| N4-mcp-list-settings | `agy mcp list --settings` (flag refused) | 0 | 1 | 0.1 |
| N4-mcp-list-wt | `agy mcp list` with `<wt>/.agents/mcp_config.json` (not listed) | 0 | 0 | 0.1 |
| N5-settings-bad | `--settings` with invalid JSON | 0 | 1 | 0.1 |
| N5-settings-mcp | `--settings` with `mcpServers` (refused) | 0 | 1 | 0.1 |
| N5-settings-unknown | `--settings` with an unknown key and permission rules | 0 | 1 | 0.1 |
| N6-gemdir-p | `-p --gemini-dir` (flag not defined headless) | 0 | 2 | 0.1 |
| P1-preflight | preflight before the sign-in: binary, version, `acp --help`, `models`, one prompt (no credential) | 0 | 1 | 60.2 |
| P2-preflight | preflight after the sign-in, `--model gemini-3.8-flash-low`: all ok, the prompt answered | 1 | 0 | 3.8 |

## User configuration

The three files the issue names, hashed before the first run (`userconfig-before.json`) and after the last. `~/.gemini` did not exist before the first `agy` run.

| File | sha256 before | sha256 after | Changed by |
|---|---|---|---|
| `~/.gemini/antigravity-cli/settings.json` | absent | 5ff2b3615b8dad859fb071346ab3d53c4311ec33c63fe48928dc1039739d8275 | the owner's interactive sign-in between N4-mcp-list-settings and A0-gemdir (15:16 local); no probe run changed it (every record has userConfigChanged []) |
| `~/.gemini/config/mcp_config.json` | absent | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | P1-preflight: the first agy run created ~/.gemini and this empty file |
| `~/.gemini/GEMINI.md` | absent | absent | unchanged |

- `~/.gemini/config/mcp_config.json` differs: the first `agy` run (P1-preflight, the preflight's `agy --version`) created `~/.gemini/config/` with this file empty (and `config.json`, `.migrated`, `projects/`).
- `~/.gemini/antigravity-cli/settings.json` differs: it was written at 15:16 local by the owner's interactive sign-in, between the runs N5/A0-init and A0-gemdir, and holds only `trustedWorkspaces` with the owner's checkout. No probe run changed it: every record's `userConfigChanged` is empty, H10b included.
- `agy` writes its own data under `~/.gemini/antigravity-cli/` whenever a run uses the user's home (every run but H3-home and A0-home): `log/cli-*.log` and `log/acp-server-*.log`, `brain/<conversation>/` (transcripts and tool outputs), `conversations/<id>.db`, `implicit/*.pb`, `presence/*.lock`, `cache/`, `bin/agentapi`, and `mcp/<server>/<tool>.json` (the tool schemas of every MCP server it started, here `mcp/orchestrator/`). The records' `geminiDirChanges` list them per run. The ACP session store keeps the `mcpServers` entry's env: the fake token was found in `conversations/<session>.db` after every ACP session that had the shim.

## Answers

### 1. Which binary and version was probed, does `agy acp --help` work, and which models does `agy models` list?

**yes.** The probe ran `agy` 1.5.13 from /opt/homebrew/bin/agy, whose `acp --help` exits 0 and whose `agy models` lists 23 slugs after the sign-in, of which gemini-3.8-flash-low was used.

- Detail: agy 1.5.13 at /opt/homebrew/bin/agy (a Homebrew wrapper that sets AGY_CLI_DISABLE_AUTO_UPDATE=true and execs the Caskroom `antigravity` binary); `agy acp --help` exits 0 with its help on stderr, and after the owner's sign-in `agy models` lists 23 slugs, of which the owner chose gemini-3.8-flash-low (before the sign-in it exited 1 with "Please sign in to view available models").
- Command: `node test/fixtures/agy/probe.mjs --preflight --model gemini-3.8-flash-low`; `node test/fixtures/agy/probe.mjs --run N1-acp-help,N1-models --model gemini-3.8-flash-low`
- Evidence: `headless/preflight.txt`, `headless/preflight-1.txt`, `headless/N1-acp-help.stderr.txt`, `headless/N1-models.stdout.txt`

### 2. Does `agy -p` take a 30 KB prompt from a file on stdin, work in the directory it is started in, and how does it end: the exit codes of a success, a failed run and an unknown flag?

**partly.** A 30 KB prompt is taken from stdin only as one `--input-format stream-json` message, the run works in its start directory, and it exits 0 on success, 1 on a failed run, 2 on an unknown flag and 3 on a reached `--print-timeout`.

- Detail: A 30 KB prompt is read from stdin only as one `--input-format stream-json` line `{"event":"user","message":{"role":"user","content":"..."}}` (answered `ready 387`, 18914 input tokens); plain text on stdin is not read (`-p ''` fails with `empty prompt`, `-p` alone with `flag needs an argument`). The run works in the directory it is started in (`init.cwd` = `<scratch>/wt`). Exit codes: 0 success, 1 a failed run (no credential, unknown model, empty prompt), 2 an unknown flag, 3 a reached `--print-timeout`.
- Command: `node test/fixtures/agy/probe.mjs --run H2-stdin,H2-stdin-json,N2-badflag,H15-timeout --model gemini-3.8-flash-low`
- Evidence: `headless/H2-stdin-json.stdout.txt`, `headless/H2-stdin.stdout.txt`, `headless/attempts/H2-stdin-json-try1.stdout.txt`, `headless/N2-badflag.stderr.txt`, `headless/H15-timeout.stderr.txt`

### 3. Does a detached process with no terminal, started as `SubprocessRunner` starts an agent, get the cached credential without an operating-system dialog?

**yes.** A detached child with no terminal used the cached sign-in with no dialog, but only under the user's HOME.

- Detail: A detached child with stdin ignored and no terminal, started as SubprocessRunner starts an agent, used the cached sign-in with no dialog and answered in 3781 ms (P2-preflight). Before the sign-in the same start printed an OAuth URL on stderr and waited 60 s for a pasted code, then exited 1; with `--print-timeout 10s` it was still waiting at the probe's 60 s limit (N3). Under a scratch HOME the cached sign-in was not found (H3-home: the same URL and wait), so the credential follows HOME.
- Command: `node test/fixtures/agy/probe.mjs --preflight --model gemini-3.8-flash-low`; `node test/fixtures/agy/probe.mjs --run N3-noauth-json,H3-home --model gemini-3.8-flash-low`
- Evidence: `headless/preflight.txt`, `headless/preflight.json`, `headless/preflight-1.txt`, `headless/N3-noauth-json.stderr.txt`, `headless/H3-home.stderr.txt`

### 4. Headless, which way gives one run its own MCP server and environment: `<worktree>/.agents/mcp_config.json`, a scratch `HOME`, or a flag or variable that `agy --help` shows? For each, does `~/.gemini` stay unchanged, and what do `git status --porcelain` and `git status --porcelain --ignored` print in the worktree afterwards?

**partly.** Only `--add-dir` with a per-launch `.agents/mcp_config.json` outside the worktree registers the shim for one run with a clean worktree and unchanged `~/.gemini` files, and the added directory can take over as the directory commands run in.

- Detail: Headless, `--add-dir <dir outside the worktree>` holding `.agents/mcp_config.json` gives one run its own shim and environment with an empty `git status --porcelain` and `--porcelain --ignored`, but the run takes its commands' directory from the workspace roots: with `<scratch>/home/launch` (sorting before `<scratch>/wt`) the commands ran there, with `<scratch>/zz-launch` in the worktree. `<worktree>/.agents/mcp_config.json` works but both statuses, taken with `--untracked-files=all`, print `?? .agents/mcp_config.json` (plain `--porcelain` would print `?? .agents/`) (the file holds the token); a scratch HOME is blocked (no credential there and no GEMINI_API_KEY); `--settings` refuses `mcpServers` (`unknown setting`) and `--gemini-dir` exists only on `agy acp`. None of the three named `~/.gemini` files changed in any of these runs; agy wrote the tool schemas to `~/.gemini/antigravity-cli/mcp/orchestrator/*.json`.
- Command: `node test/fixtures/agy/probe.mjs --run H4a-wt,H4b-adddir,H9-norule,H9b-norule-order,H3-home,N5-settings-mcp,N6-gemdir-p --model gemini-3.8-flash-low`
- Evidence: `records/H4a-wt.json`, `records/H4b-adddir.json`, `records/H9-norule.json`, `records/H9b-norule-order.json`, `headless/H4a-wt.stdout.txt`, `headless/H4b-adddir.stdout.txt`, `shim/H4b-adddir.jsonl`, `headless/H3-home.stderr.txt`, `headless/N5-settings-mcp.stderr.txt`, `headless/N6-gemdir-p.stderr.txt`

### 5. Over ACP, what does `agy acp` answer to `initialize` (protocol version, capabilities, auth methods)? Does a stdio server named in `session/new.mcpServers` start for that session, under which parent, and is `--process-per-session` needed?

**yes.** `agy acp` answers protocol version 1 with four auth methods, and a server named in `session/new.mcpServers` starts for that session as a child of the agent, without `--process-per-session`.

- Detail: `initialize` answers protocolVersion 1, agentCapabilities (loadSession, promptCapabilities image and embeddedContext, sessionCapabilities resume/close/load/list/additionalDirectories, auth.logout) and four authMethods (oauth-personal, oauth-business, gemini-api-key, agent-platform). The stdio server named in `session/new.mcpServers` started for that session as a child of the `antigravity` process, in the client's process group, without `--process-per-session`; before the sign-in `session/new` failed -32000 `Authentication required` and the shim never started. The entry's env, the fake token included, is stored in `~/.gemini/antigravity-cli/conversations/<session>.db` (with `--gemini-dir <scratch>/home/gem`, under that directory instead).
- Command: `node test/fixtures/agy/probe.mjs --run A0-init,A0-session,A0-gemdir,A1-shim --model gemini-3.8-flash-low`
- Evidence: `acp/A0-init.frames.jsonl`, `acp/A1-shim.frames.jsonl`, `shim/A1-shim.jsonl`, `records/A1-shim.json`, `records/A0-gemdir.json`

### 6. What does the shim's process receive (the entry's `env`, the parent's environment, both), and under which names does the model see the five tools?

**yes.** The shim gets the entry's `env` over the parent's environment, and the model reaches its tools through `call_mcp_tool` headless and as `mcp_orchestrator_<tool>` over ACP.

- Detail: The shim received both: the entry's `env` (ORCH_* and `PROBE_MARKER=from-entry-env`, which overrode the parent's `from-agy-env`) on top of the parent's environment (PATH, HOME, USER, LANG, TMPDIR, PWD, SHLVL and the wrapper's AGY_CLI_DISABLE_AUTO_UPDATE), with the worktree as its cwd. Headless the five tools are not in `init.tools`: the model reaches them through `call_mcp_tool` with ServerName `orchestrator` and ToolName `heartbeat`, after reading the schema agy wrote to `~/.gemini/antigravity-cli/mcp/orchestrator/heartbeat.json`; over ACP they are `mcp_orchestrator_<tool>` (`Run mcp_orchestrator_heartbeat`).
- Command: `node test/fixtures/agy/probe.mjs --run H4a-wt,H4b-adddir,A1-shim --model gemini-3.8-flash-low`
- Evidence: `shim/H4a-wt.jsonl`, `shim/H4b-adddir.jsonl`, `shim/A1-shim.jsonl`, `headless/H4a-wt.stdout.txt`, `acp/A1-shim.client.jsonl`

### 7. When the shim's command cannot start, does the run fail or go on without the tools, and what do stdout, stderr and the exit code say, headless and over ACP?

**yes.** A shim that cannot start fails nothing: headless and over ACP the run ends successfully with exit 0 and no line that names the failure.

- Detail: Neither way fails: headless (H7) the run ended `SUCCESS` with exit 0 and an empty stderr, and over ACP (A7) `session/new` succeeded and the turn ended `end_turn` with an empty stderr; no output, frame or log line names the failure (the ACP log says only `Preloading 1 MCP servers of the session`). The model then found the schemas cached in `~/.gemini/antigravity-cli/mcp/orchestrator/` by earlier runs and, with every action approved, read files outside the scratch directory (this checkout's fixtures and agy's own transcripts) before answering with the five tool names. Every command it ran was a read (`ls`, `cat`, `grep`, `tail`, `find`, `env`, `ps`, and `python3` reading files).
- Command: `node test/fixtures/agy/probe.mjs --run H7-badshim,A7-badshim --model gemini-3.8-flash-low`
- Evidence: `headless/H7-badshim.stdout.txt`, `headless/H7-badshim.stderr.txt`, `acp/A7-badshim.client.jsonl`, `acp/A7-badshim.stderr.txt`, `acp/A7-badshim.log0.txt`

### 8. Is the `block` call answered after 200 s cut? Does `timeoutSeconds` on the entry lift the limit headless? Is a server named over ACP cut, and can anything lift that limit per launch?

**partly.** The 200 s `block` is cut at 180 s both ways; `timeoutSeconds` lifts the cut headless, and nothing tried lifts it over ACP.

- Detail: Yes, a `block` answered after 200 s is cut at 180 s (`MCP tool call to server "orchestrator" timed out after 3m0s: context deadline exceeded`; the shim got `notifications/cancelled` at 180.0 s) headless and over ACP, and the model is told and the turn goes on. Headless, `timeoutSeconds: 300` on the entry lifts the cut (the 200 s answer arrived). Over ACP, neither `timeoutSeconds` nor `_meta.timeoutSeconds` on the `session/new` entry lifted it (A8b), and other shapes, such as a `timeoutSeconds` entry in an `mcp_config.json` under a per-launch `--gemini-dir`, were not tried (run cap).
- Command: `node test/fixtures/agy/probe.mjs --run H8-trio,A8b-block-meta --model gemini-3.8-flash-low`
- Evidence: `headless/H8a-block-default.stdout.txt`, `headless/H8b-block-300.stdout.txt`, `shim/H8a-block-default.jsonl`, `shim/H8b-block-300.jsonl`, `acp/A8-block.client.jsonl`, `shim/A8-block.jsonl`, `acp/A8b-block-meta.frames.jsonl`, `shim/A8b-block-meta.jsonl`

### 9. Headless with no rule, what happens to a shell command, a file write in the worktree, a write outside it and a shim tool call: the notice on stderr, what the model is told, whether the run goes on, and the exit code?

**partly.** With no rule, the command and the worktree write ran, the write outside was denied to the model with a stderr notice, the turn then ended with exit 0, and the shim call was never reached.

- Detail: With no rule (H9b) `git status --short` ran and the write in the worktree was done; the write outside it was refused to the model as `permission check failed for write_file ...: user denied permission ... Do not attempt to circumvent this denial`, after which the turn ended with an empty response and `denied_actions` in the result, stderr said `jetski: no output produced — a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied...`, and the exit code was 0. The shim call after the denial was never made, so a shim tool call without a rule was not observed headless (over ACP it asks, Q11).
- Command: `node test/fixtures/agy/probe.mjs --run H9-norule,H9b-norule-order --model gemini-3.8-flash-low`
- Evidence: `headless/H9b-norule-order.stdout.txt`, `headless/H9b-norule-order.stderr.txt`, `headless/H9-norule.stdout.txt`, `headless/H9-norule.stderr.txt`

### 10. Which per-launch means removes every prompt: `--dangerously-skip-permissions`, `--mode`, or `permissions.allow` rules such as `command(git)` and `mcp(orchestrator/*)`? Can rules be given without writing the user's settings file, and does the behaviour of issue 565 show?

**partly.** `--dangerously-skip-permissions` and `--settings` permission rules each remove every prompt for one run without writing the settings file, and issue 565 did not show.

- Detail: `--dangerously-skip-permissions` removed every prompt (H10a: all four steps, the write outside the worktree too, `permission_mode` `always-proceed`), and `--settings '{"permissions":{"allow":["command(git)","write_file(<scratch>/)","mcp(orchestrator/*)"]}}'` gave rules for one run without writing `settings.json` (H10b: all four steps done, every hash unchanged). The behaviour of issue 565 did not show, though `git status` also ran without a rule (H9b), so this run cannot tell it apart; `--mode` was not tried (run cap).
- Command: `node test/fixtures/agy/probe.mjs --run H10a-skip,H10b-rules,N5-settings-unknown --model gemini-3.8-flash-low`
- Evidence: `headless/H10a-skip.stdout.txt`, `headless/H10b-rules.stdout.txt`, `records/H10b-rules.json`, `headless/N5-settings-unknown.stderr.txt`

### 11. Over ACP, which actions arrive as `session/request_permission`, with which options and which fields naming the command? After `reject_once` does the turn go on, and with no answer what happens within 120 s?

**yes.** MCP calls and shell commands arrive as `session/request_permission` with only allow_once and reject_once, `reject_once` ends the turn, and an unanswered request waits until cancelled.

- Detail: Without rules, the shim's tool call (kind `other`, title `Run mcp_orchestrator_heartbeat`, `rawInput` = the arguments plus `toolSummary`) and the shell command (kind `execute`, title = the command line, `rawInput.CommandLine`) each arrive as `session/request_permission` with exactly two options, `allow` (allow_once) and `deny` (reject_once). After `reject_once` the turn ended at once with `end_turn` and no message, and the workspace write the model had queued was reported `failed`. Unanswered, no frame came for 127 s and the turn waited; SIGTERM then made the client cancel and the agent exit, leaving no process.
- Command: `node test/fixtures/agy/probe.mjs --run A1-shim,A11-noanswer --model gemini-3.8-flash-low`
- Evidence: `acp/A1-shim.client.jsonl`, `acp/A1-shim.frames.jsonl`, `acp/A11-noanswer.client.jsonl`, `acp/A11-noanswer.frames.jsonl`

### 12. Does the agent commit on the launch branch in a linked worktree, without `--sandbox` and with it?

**yes.** The agent committed on `task/PROBE/l1` in the linked worktree both without and with `--sandbox`.

- Detail: Yes, both: without `--sandbox` the agent committed `ed4f7f0 add hello` and with `--sandbox` `89d1690 add hello` on `task/PROBE/l1` in the linked worktree, with `git add` and `git commit` run by its own shell tool.
- Command: `node test/fixtures/agy/probe.mjs --run H12a-commit,H12b-commit-sandbox --model gemini-3.8-flash-low`
- Evidence: `headless/H12a-commit.stdout.txt`, `headless/H12b-commit-sandbox.stdout.txt`, `records/H12a-commit.json`, `records/H12b-commit-sandbox.json`

### 13. Do `--model` and `--effort` take effect, do the model slugs fit `MODEL_PATTERN`, what does an unknown model print, and how are both set over ACP?

**partly.** `--model` takes effect and every slug fits `MODEL_PATTERN`, but no output shows `--effort`; an unknown model exits 1 headless and is refused -32602 over ACP.

- Detail: `--model` takes effect (`init.model` is the slug given), and `--model gemini-3.8-flash --effort low` was accepted, but no output or log line shows the effort, so whether it applied is not shown. All 23 slugs fit `MODEL_PATTERN`. An unknown model exits 1 with `error: invalid model selection (--model "null" --effort ""): model null is not recognized as a known model or custom model in settings` and the list. Over ACP the model is `session/set_model` or `session/set_config_option` id `model` (an unknown one is refused -32602 `Unknown model ID: no-such-model`); `configOptions` also offer `thought_level`, and the default model is `gemini-4-neon-high`.
- Command: `node test/fixtures/agy/probe.mjs --run H13-effort,H13-nullmodel,A0-session --model gemini-3.8-flash-low`
- Evidence: `headless/H13-effort.stdout.txt`, `headless/H13-nullmodel.stderr.txt`, `acp/A0-session.client.jsonl`, `headless/N1-models.stdout.txt`

### 14. Which numbers do `--output-format json` and `stream-json` end with; does `input_tokens` include `cache_read_tokens`; is a cost reported; and what does ACP carry?

**yes.** Headless ends with input, output, thinking, cache-read and total tokens (input excluding cache reads) and ACP with input, output, cached-read, cached-write, thought and total tokens, neither with a cost.

- Detail: `json` and the final `stream-json` `result` end with `usage` {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens} for the whole turn (each `step_update` of an agent step carries its own), and no cost; `input_tokens` excludes `cache_read_tokens` (H4a: input 16287, cache_read 23121, total 16437 = input + output). ACP carries `usage` on the prompt answer {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens}, where totalTokens includes cached reads (A7: 61890 + 2177 + 429214 = 493281), and `usage_update` {used, size}; no cost.
- Command: `node test/fixtures/agy/probe.mjs --run H4a-wt,A7-badshim,A1-shim --model gemini-3.8-flash-low`
- Evidence: `headless/H4a-wt.stdout.txt`, `headless/H2-stdin-json.stdout.txt`, `acp/A1-shim.client.jsonl`, `acp/A7-badshim.client.jsonl`

### 15. What are the exact stdout, stderr and exit code, and the ACP error, for no credential, an unknown model, a shim that did not start, a soft-denied action and a reached `--print-timeout`?

**yes.** Each failure has its own exit code or error except a shim that did not start, which shows nowhere.

- Detail: No credential: exit 1 after a 60 s wait, stderr `Authentication required. Please visit the URL to log in` and `error: authentication failed or timed out`, json `status` ERROR; over ACP -32000 `Authentication required`. Unknown model: exit 1, `error: invalid model selection ...`; over ACP -32602 `Unknown model ID`. A shim that did not start: nothing, exit 0. A soft-denied action: exit 0, stderr `jetski: no output produced — ...`, `denied_actions` in the result. A reached `--print-timeout`: exit 3, stderr `error: print timeout after 10s with the turn still in progress; the response is partial` and `AGY_ERROR: {..."status":"DEADLINE_EXCEEDED","reason":"print_timeout"}`, `finished_reason` `print_timeout`.
- Command: `node test/fixtures/agy/probe.mjs --run N3-noauth-json,A0-init,H13-nullmodel,A0-session,H7-badshim,H9b-norule-order,H15-timeout --model gemini-3.8-flash-low`
- Evidence: `headless/N3-noauth-json.stdout.txt`, `headless/N3-noauth-json.stderr.txt`, `acp/A0-init.frames.jsonl`, `headless/H13-nullmodel.stderr.txt`, `acp/A0-session.client.jsonl`, `headless/H7-badshim.stderr.txt`, `headless/H9b-norule-order.stderr.txt`, `headless/H15-timeout.stderr.txt`, `headless/H15-timeout.stdout.txt`

### 16. Isolation and process behaviour: what a run reads from the user's setup and how each is switched off per launch; whether a first run in a new directory asks to trust it; what a run writes into the worktree; whether two runs started together both finish; the longest gap between `stream-json` lines; whether SIGTERM to the process group leaves a process.

**partly.** No run asked for trust, wrote into the worktree on its own or left a process, three runs started together all finished, and the longest silence was 200 s during a tool call, while every run read the built-in skills and wrote under `~/.gemini`.

- Detail: Every run read the built-in skills and plugins under `~/.gemini/antigravity-cli/builtin` (`Reloading system slash commands and skills`); `~/.gemini/GEMINI.md` did not exist, and a per-launch switch was not tried (`agy acp --include-default-customizations` and `--disable-slash-commands` exist). No run asked to trust its fresh directory, and no run wrote into the worktree beyond what the model wrote, while each wrote under `~/.gemini/antigravity-cli` (brain/, conversations/, implicit/, presence/, mcp/<server>/, log/). The three runs started together (H8a, H8b, A8) all finished; the longest gap between `stream-json` lines was 200 s, during the block call; after SIGTERM to the client's group (A11) and after the print timeout (H15) no process was left. SIGTERM during a headless shell command was not probed (run cap).
- Command: `node test/fixtures/agy/probe.mjs --run H8-trio,A11-noanswer,H15-timeout,H4b-adddir --model gemini-3.8-flash-low`
- Evidence: `records/H8b-block-300.json`, `records/H8a-block-default.json`, `records/A8-block.json`, `records/A11-noanswer.json`, `records/H15-timeout.json`, `records/H4b-adddir.json`, `acp/A1-shim.log0.txt`

## For the decision record

The criteria are the twelve of `test/fixtures/acp/README.md`. Each cell is `pass`, `fail`, `partly` or `not probed`, with the question (Q) of this probe it rests on. Since 2026-11-20 the grading rule of the decision record (`openspec/changes/archive/2026-11-20-harness-integration-shape/design.md`, section 2) governs this table: a workaround counts only when this probe ran it, and a gap that was not probed grades `partly`. The cells the review named were graded again by it; the other `pass` cells were not re-examined (the record's open question 24). Three cells were graded again by it: `agy -p` C3 and C11, and the workaround of `agy acp` C4.

| Criterion | `agy -p` | `agy acp` |
|---|---|---|
| C1 Registration | partly: `--add-dir` with a per-launch `.agents/mcp_config.json` outside the worktree registers the shim with the launch's env and leaves both `git status` outputs empty, but the added directory competes with the worktree as the directory commands run in (it won when it sorted first). A file in the worktree is untracked and holds the token; no flag or variable names an MCP config (Q4, Q6) | pass with a residue: `session/new.mcpServers` registers the shim per session with its env and writes nothing in the worktree, but agy keeps that env, token included, in `conversations/<session>.db` under `~/.gemini` (or under `--gemini-dir`) (Q5, Q6) |
| C2 Required | fail: a shim that cannot start leaves exit 0, `SUCCESS` and an empty stderr; the model then searched the machine for the tools (Q7, Q15) | fail: `session/new` succeeds and no frame or stderr line says the server failed (Q7, Q15) |
| C3 No human | partly (regraded 2026-11-20): headless never waits for a person; an action without a rule is auto-denied with a stderr notice, `denied_actions` and exit 0, but the turn ends there, so later steps are lost and the run does not go on as C3 asks (Q9, `headless/H9b-norule-order.stderr.txt`) | partly: without rules every MCP call and command arrives as `session/request_permission` (allow_once/reject_once only); `reject_once` ends the turn, and an unanswered request waits until cancelled (Q11) |
| C4 Rules | pass: `--settings '{"permissions":{"allow":[...]}}'` gives rules for one run without writing `settings.json`, and `--dangerously-skip-permissions` removes every prompt (Q10) | partly: the client's policy answers each request (Q11); `agy acp` has no `--settings`, so per-launch rules would need a settings file under a per-launch `--gemini-dir`, not probed, so it does not count as a workaround (Q5, Q10) |
| C5 Timeout | pass: `timeoutSeconds` on the entry lifts the 180 s cut (Q8) | fail: a server passed over ACP is cut at 180 s, and neither `timeoutSeconds` nor `_meta.timeoutSeconds` on the entry lifted it; a same-named entry under a per-launch `--gemini-dir` was not tried (Q8) |
| C6 Commit | pass: commits on `task/PROBE/l1` in the linked worktree, with and without `--sandbox` (Q12) | not probed over ACP; the session works in `session/new.cwd` (the shim's cwd was the worktree, Q6) and the headless agent commits (Q12) |
| C7 Selection | partly: `--model <slug>` applies and every slug fits `MODEL_PATTERN`; `--effort` is accepted but not shown anywhere; an unknown model exits 1 with a clear message (Q13) | pass: `session/set_model` (or `set_config_option` `model`) and the `thought_level` option; an unknown model is refused -32602 (Q13) |
| C8 Usage | pass: the final `usage` sums the turn: input, output, thinking and cache-read tokens, with input excluding cache reads; no cost (Q14) | partly: the prompt answer carries input, output, cached-read, cached-write and thought tokens, with a total that includes cache reads; `usage_update` gives only the context fill; no cost (Q14) |
| C9 Failures | partly: no credential (exit 1 after a 60 s wait), an unknown model (exit 1), a print timeout (exit 3, `AGY_ERROR` with `reason`), an unknown flag (exit 2) and a denial (stderr notice) can be told apart; a shim that did not start cannot (Q2, Q15) | partly: -32000 `Authentication required` and -32602 `Unknown model ID` are distinct; a shim that did not start shows nowhere (Q15) |
| C10 Isolation | partly: the cached sign-in exists only under the user's HOME, so every run writes its conversations, logs and the shim's tool schemas under `~/.gemini/antigravity-cli`; the three named files stayed unchanged; `--gemini-dir` is not a headless flag (Q3, Q4, Q16) | partly: `--gemini-dir <dir>` moved the data directory and still found the sign-in (A0-gemdir, no prompt sent); built-in skills are loaded unless `--include-default-customizations=false`, not tried (Q5, Q16) |
| C11 Process | partly (regraded 2026-11-20): detached, no terminal, stdin ignored; the shim runs in the process group; no process left after any run or the print timeout; no line during a 200 s tool call; SIGTERM during a headless shell command was not probed (Q3, Q16) | partly: the shim is a child of `antigravity` in the client's group and SIGTERM left nothing, but no frame arrives during a long tool call and an unanswered permission waits without end (Q5, Q11, Q16) |
| C12 Stability and residue | partly: `json` and `stream-json` are typed (`init`, `step_update`, `result`, `finished_reason`), but the stdin message shape is undocumented and was learned from an error (Q2, Q14). Per harness: the launch flags, `--add-dir` registration, `--settings` rules, the stderr notices and `AGY_ERROR`, and the tool route through `call_mcp_tool` (Q4, Q6, Q15) | partly: ACP version 1 is versioned (Q5). Still per harness: the launch command, `session/set_model`, the tool names `mcp_orchestrator_<tool>`, the 180 s cut, the auth error -32000 and the env persisted in agy's store (Q5, Q6, Q8, Q13) |
