## Context

Three probes, merged on 2026-11-20, are the only input to this record. No CLI and no model was run for it. Each probe README ends with a section "For the decision record" that grades the twelve criteria below for its two paths. The cells in this design are copied from those sections. On 2026-11-20 the review of the milestone found cells that the probes graded by different readings. Those cells were graded again by one rule, stated in section 2, in this table and in the probe READMEs alike (see "Corrections (2026-11-20)" at the end).

- **OpenCode** (#197, `test/fixtures/acp/README.md`): `opencode` 1.18.30 on the free model `opencode/big-pickle`. OpenCode is already a shipped kind, of shape (A): `OpenCodeRunner` runs `opencode run --format json`. The probe drove `opencode acp --pure` with a hand-framed ACP v1 client (`test/fixtures/acp/acp-client.mjs`) and a recording shim. It compared the result with what `opencode run` gives, from the shipped code and `test/fixtures/opencode/README.md`. 13 scenarios used the model.
- **Antigravity CLI** (#198, `test/fixtures/agy/README.md`): `agy` 1.5.13 (`/opt/homebrew/bin/agy`) on `gemini-3.8-flash-low`, with the cached sign-in. The probe drove `agy -p` headless and `agy acp` with the #197 client. 43 runs were made, 20 of them with a model call.
- **Hermes Agent** (#199, `test/fixtures/hermes/README.md`): `hermes` "Hermes Agent vunknown (2026.9.24)", Homebrew hermes-agent 0.22.4_1, on provider `nous` with model `qwen/qwen4-max:free`. The probe drove `hermes -z` and `hermes chat -q` headless, and `hermes acp` with a copy of the #197 client that keeps descendants. It made 20 model runs. Its main finding is that the work runs under a gateway daemon, outside the process group the caller starts (hermes Q2).

A spawned agent is detached and must survive the daemon (`src/runner/subprocess.ts`; `openspec/specs/crash-recovery/spec.md`). So shape (B) is judged as a per-launch driver process that speaks ACP. The daemon starts it like any other agent command. It is not judged as a session held inside the daemon.

## Goals / Non-Goals

**Goals:**

- For each of OpenCode, `agy` and `hermes`, a decision: A, B, none or `not decided`. Each decision comes from the twelve criteria and one rule, both fixed before the results were read.
- The questions the owner decides at the milestone review, each with its options.
- A task list for the two later milestones that follows from the decision.

**Non-Goals:**

- Building an adapter, an ACP driver or a kind. No file under `src/`, `hosts/` or `test/` changes.
- Re-running a probe, or answering a question the probes left open.
- Probing Claude Code or Codex over ACP. Neither may be started on the probe machine.
- Changing a requirement. The change has no `specs/` directory.

## Decisions

### 1. The criteria

These are the twelve criteria, as the task fixed them on 2026-11-20:

- **C1 Registration.** The shim is registered for one launch, with that launch's identity. Registering it writes no user configuration and leaves no file in the worktree outside `.orchestrator/`.
- **C2 Required.** A shim that did not start is known before a model turn is paid for, or shows as a named failure afterwards.
- **C3 No human.** No action waits on a person. A refused action comes back to the model as an error and the run goes on, so the worker can ask a `needsAccess` question.
- **C4 Rules.** The allowed tools and commands can be set per launch as a ruleset, not only as all or nothing.
- **C5 Timeout.** An MCP tool call can outlast `maxWaitMs` (a `block` long-poll), set per launch.
- **C6 Commit.** The agent commits in a linked worktree, or the `daemon` commit policy covers it.
- **C7 Selection.** The model and the effort are set per launch, and the model names fit a pattern the daemon can check.
- **C8 Usage.** The launch's input and output tokens can be read when it ends, with a cost or with a model the price table can price.
- **C9 Failures.** The output tells apart an unknown model, a missing credential, a shim that did not start and a refused action.
- **C10 Isolation.** The run neither reads nor writes the user's configuration, memory, plugins or history, and two launches started together both run.
- **C11 Process.** All work runs under the process group the supervisor started, and ends when that group is signalled. The process ends after the turn or can be ended cleanly. Output arrives while it works.
- **C12 Stability and residue.** The interface is documented and versioned. The residue is what must still be written for each harness on this path: the launch command, the environment, the configuration that makes it ask or stop asking, the model setter, the failure patterns and the tool-name wording.

### 2. The criteria table

**The grading rule** (decided 2026-11-20). Every cell below, and every cell of the probe READMEs' "For the decision record" tables, is graded by it:

- A workaround counts only when the probe ran it. A setting read from `--help`, from the source or from a document, and not run, is not a workaround.
- A gap that was not probed, inside a cell whose other parts were probed, grades `partly`, not `pass`. `opencode run` C11 is the model case: the bash tool's group was not probed, so the cell is `partly`.
- A criterion that was not probed at all on a path stays `not probed`.

The rule governs this table. On 2026-11-20 the cells the review named were graded again by it, and every workaround of a cell that is not `pass` was checked against it (section 4). The other `pass` cells were not re-examined; open question 24 lists the candidates.

Each cell starts with its grade (`pass`, `fail`, `partly` or `not probed`), copied from the probe's section "For the decision record". The reference follows the grade:

- `oc Qn` is a question of `test/fixtures/acp/README.md`.
- `agy Qn` is a question of `test/fixtures/agy/README.md`.
- `hermes Qn` is a question of `test/fixtures/hermes/README.md`.
- In the `opencode run` column, the reference is the file that `test/fixtures/acp/README.md` names for that cell.

The note after the reference sums up the probe's text.

| Criterion | `opencode run` | `opencode acp` | `agy -p` | `agy acp` | `hermes headless` | `hermes acp` |
|---|---|---|---|---|---|---|
| C1 Registration | pass (`test/fixtures/opencode/brief-run/cfg-q3.json`, `src/runner/opencode.ts`): `mcp.orchestrator` in a per-launch `OPENCODE_CONFIG_CONTENT` | pass (oc Q4, oc Q18): `session/new.mcpServers`; nothing written | partly (agy Q4, agy Q6): `--add-dir` outside the worktree works, but the added directory can become the commands' directory | pass (agy Q5, agy Q6): `session/new.mcpServers`; agy stores the entry's env, token included, under `~/.gemini` | pass (hermes Q4): `mcp_servers.orchestrator` in a per-launch `HERMES_HOME` | pass (hermes Q5): `session/new.mcpServers`; token found nowhere |
| C2 Required | partly (`test/fixtures/opencode/events/D4.err`, `test/fixtures/opencode/events/D4.jsonl`): classified `mcpStartupFailed` after the turn | partly (oc Q5, oc Q15): a stderr WARN under `--print-logs`, before any prompt | fail (agy Q7, agy Q15): exit 0, `SUCCESS`, nothing said | fail (agy Q7, agy Q15): `session/new` succeeds, nothing said | fail (hermes Q7): exit 0; only the gateway log says so | fail (hermes Q7): only the gateway log says so |
| C3 No human | pass (`test/fixtures/opencode/events/P-deny.jsonl`, `test/fixtures/opencode/events/P-ask.jsonl`): `deny` returns to the model; `ask` ends the run | pass (oc Q8, oc Q9): under `deny` the model asked `needsAccess` | partly (agy Q9, `test/fixtures/agy/headless/H9b-norule-order.stderr.txt`): auto-denied, exit 0, but the turn ends at the denial, so the run does not go on | partly (agy Q11): every call asks; `reject_once` ends the turn; no answer waits | pass (hermes Q9, hermes Q10): `approvals.mode: off`; `chat -q` refuses at once and goes on | partly (hermes Q11): a dangerous command asks; `deny` goes on; the timeout was not seen |
| C4 Rules | pass (`test/fixtures/opencode/events/X-chain-allowed.jsonl`, `test/fixtures/opencode/events/X-chain-offpattern.jsonl`): the derived ruleset | pass (oc Q7, oc Q8): the same ruleset applies | pass (agy Q10): `--settings` permission rules for one run | partly (agy Q11, agy Q5, agy Q10): only per-request answers; no `--settings` on `agy acp`; a settings file under `--gemini-dir` was not probed, so it is no workaround | partly (hermes Q10): `--toolsets` and `tools.include` hide tools rather than refuse them | not probed (hermes Q11) |
| C5 Timeout | pass (`test/fixtures/opencode/events/T4.jsonl`, `test/fixtures/opencode/configs/cfg-slow-perserver.json`): `mcp.orchestrator.timeout` | pass (oc Q6): a disabled `mcp.orchestrator` entry with `timeout` lifts the 60 s cut | pass (agy Q8): `timeoutSeconds` lifts the 180 s cut | fail (agy Q8): cut at 180 s; nothing on the entry lifted it | pass (hermes Q8): `timeout` on the entry lifted the 300 s cut | partly (hermes Q8): cut at 300 s; `timeouts.mcp.tool_call` not run |
| C6 Commit | pass (`test/fixtures/opencode/brief-run/Q3-1.jsonl`) | pass (oc Q18): committed in the linked worktree | pass (agy Q12): with and without `--sandbox` | not probed (agy Q12, agy Q6) | pass (hermes Q12) | not probed (hermes Q12) |
| C7 Selection | partly (`test/fixtures/opencode/events/I1.jsonl`): `--variant` accepted silently | partly (oc Q14, oc Q7): unknown model in config dropped silently; no effort option | partly (agy Q13): `--effort` shown nowhere | pass (agy Q13): `session/set_model`, `thought_level` | partly (hermes Q13, `test/fixtures/hermes/headless/H2.usage.json`): `-m` applies; names fail `MODEL_PATTERN`; `--reasoning` read from help only, not run | partly (hermes Q13, `test/fixtures/hermes/acp/A0-1.frames.jsonl`): the model from the home's config; `set_model` run only with an unknown id; `set_config_option` for effort silently empty |
| C8 Usage | pass (`test/fixtures/opencode/events/SA-proj2.jsonl`, `src/runner/opencode.ts`): summed `step_finish` | fail (oc Q13): usage of the last step only | pass (agy Q14): turn totals, no cost | partly (agy Q14): totals, no cost | pass (hermes Q14): usage file with an estimated cost | partly (hermes Q14): tokens, no cost |
| C9 Failures | pass (`test/fixtures/opencode/events/E-badmodel.jsonl`, `test/fixtures/opencode/events/D4.err`, `test/fixtures/opencode/events/K2.err`): seven reasons | partly (oc Q15): config model silent; credential not probed | partly (agy Q2, agy Q15): a failed shim cannot be told | partly (agy Q15): a failed shim shows nowhere | partly (hermes Q15, hermes Q3, hermes Q7, `test/fixtures/hermes/headless/H7.out`): exit codes and texts; a failed shim only in the gateway log | partly (hermes Q15): `data.details` codes; a failed shim only in logs |
| C10 Isolation | partly (`test/fixtures/opencode/events/K2.err`, `test/fixtures/opencode/events/SA-proj.err`): 4 of 23 starts hit `database is locked` | pass (oc Q17): per-launch HOME and XDG; 8 of 8 starts | partly (agy Q3, agy Q4, agy Q16): writes under `~/.gemini`; sign-in only under the user's HOME | partly (agy Q5, agy Q16): `--gemini-dir` moves the data | partly (hermes Q4, hermes Q6, hermes Q16): one `HERMES_HOME` per launch needed | partly (hermes Q2, hermes Q16): one `HERMES_HOME` per launch needed |
| C11 Process | partly (`test/fixtures/opencode/e2e-T2.jsonl`, `src/runner/subprocess.ts`): the bash tool's group not probed | partly (oc Q10, oc Q11, oc Q12, oc Q16): the bash tool's command outlives SIGTERM and SIGKILL of the group | partly (agy Q3, agy Q16): nothing left after any run, but SIGTERM during a headless shell command was not probed | partly (agy Q5, agy Q11, agy Q16): an unanswered request waits without end | fail (hermes Q2, hermes Q16): the gateway, shim and commands outlive SIGTERM | fail (hermes Q2, hermes Q16): the same |
| C12 Stability and residue | partly (`test/fixtures/opencode/events/C2.jsonl`, `src/runner/opencode.ts`): events not versioned; 6 items | partly (oc Q1, oc Q2, oc Q4, oc Q14, oc Q15): ACP v1; 6 of 6 items | partly (agy Q2, agy Q14, agy Q4, agy Q6, agy Q15): typed stream; stdin shape undocumented | partly (agy Q5, agy Q6, agy Q8, agy Q13): ACP v1; 6 items | partly (hermes Q2, hermes Q3, hermes Q6, hermes Q9, hermes Q14): not versioned | partly (hermes Q2, hermes Q5, hermes Q13, hermes Q15): ACP v1; 6 items |

### 3. The rule

The task fixed this rule on 2026-11-20. The owner confirms or changes it at the review.

- A path passes for a harness when:
  - C1, C3, C5 and C11 are `pass`. For these four cells, a `partly` does not pass.
  - C2, C4, C6, C7, C9 and C10 are each `pass`, or have a workaround that the probe ran (the grading rule of section 2). A workaround the probe README names but did not run does not count.
- C8 does not decide whether a path passes. It sorts a passing path into "priced" or "unpriced".
- The shape follows from the passing paths:
  - Only the headless path passes: the harness gets (A).
  - Only the ACP path passes: it gets (B).
  - Both pass: the path with fewer residue items under C12 wins. A tie goes to (A).
  - Neither passes: no kind. The harness stays reachable only as a user-supplied `runnerCommand`.
- A path whose C1, C3, C5 or C11 cell is `not probed` is undecided. A harness with no passing path and at least one undecided path gets `not decided`.

No C1, C3, C5 or C11 cell in the table is `not probed`, so no path is undecided. The three `not probed` cells are `agy acp` C6, `hermes acp` C4 and `hermes acp` C6. They are not among those four criteria.

### 4. Decision per harness

The rule is applied in two steps for each path:

1. Check C1, C3, C5 and C11.
2. Check every cell among C2, C4, C6, C7, C9 and C10 that is not `pass`, and record whether the probe ran a workaround for it. By the grading rule of section 2, a workaround the probe README names but did not run does not count.

The table below is the second application of the rule, made on 2026-11-20 after the regrade. The first application is in the git history of this file.

| Path | C1, C3, C5, C11 not `pass` | C2, C4, C6, C7, C9, C10 not `pass` | Passes |
|---|---|---|---|
| `opencode run` | C11 `partly` (the bash tool's group not probed) | C2 `partly`, workaround run: the `mcpStartupFailed` classification after the turn (`test/fixtures/opencode/events/D4.jsonl`). C7 `partly`, none run (`--variant` accepted silently, `test/fixtures/opencode/events/I1.jsonl`). C10 `partly`, workaround run: a private `XDG_DATA_HOME` per launch removed the lock (`test/fixtures/opencode/README.md`, run SC), which `dataDir: launch` sets | no: C11, C7 |
| `opencode acp` | C11 `partly` (the bash tool's command outlives the group, oc Q12) | C2 `partly`, workaround run: read the stderr WARN under `--print-logs` before the prompt (oc Q5). C7 `partly`, workaround run for the model only (`session/set_config_option` refuses an unknown one, oc Q14), none for effort (the `effort` option is refused, oc Q7). C9 `partly`, none run (a model in the configuration is silent, a missing credential not probed) | no: C11, C7, C9 |
| `agy -p` | C1 `partly` (the added directory can become the commands' directory, agy Q4). C3 `partly` (the turn ends at the auto-denial, agy Q9). C11 `partly` (SIGTERM during a headless shell command not probed, agy Q16) | C2 `fail`, none run. C7 `partly`, none run (`--effort` shown nowhere, agy Q13). C9 `partly`, none run (a failed shim is silent). C10 `partly`, none run for headless (`--gemini-dir` is not a headless flag) | no: C1, C3, C11, C2, C7, C9, C10 |
| `agy acp` | C3 `partly`, C5 `fail`, C11 `partly` | C2 `fail`, none run. C4 `partly`, none run (a per-launch settings file under `--gemini-dir` is named but was not probed, agy Q10). C6 `not probed`. C9 `partly`, none run. C10 `partly`, workaround run: `--gemini-dir` (agy Q5, run A0-gemdir) | no: C3, C5, C11, C2, C4, C6, C9 |
| `hermes headless` | C11 `fail` (the gateway and its children outlive the group, hermes Q2) | C2 `fail`, none run. C4 `partly`, none run (`--toolsets` hides tools; `command_allowlist` not probed, hermes Q10). C7 `partly`, workaround run for the model only (`-m` applies, H2, and the names fit `OPENCODE_MODEL_PATTERN`, hermes Q13), none for effort (`--reasoning` read from help only). C9 `partly`, none run (a failed shim shows only in the gateway log, hermes Q7). C10 `partly`, workaround run: one `HERMES_HOME` per launch | no: C11, C2, C4, C7, C9 |
| `hermes acp` | C3 `partly`, C5 `partly`, C11 `fail` | C2 `fail`, none run. C4 `not probed`. C6 `not probed`. C7 `partly`, workaround run for the model only (the home's `config.yaml`, `test/fixtures/hermes/acp/A2.logs.txt`), none for effort (`set_config_option` answers an empty list; `session/set_model` was run only with an unknown id, hermes Q13). C9 `partly`, none run. C10 `partly`, workaround run: one `HERMES_HOME` per launch | no: C3, C5, C11, C2, C4, C6, C7, C9 |

No C1, C3, C5 or C11 cell is `not probed`, so no path is undecided. C8 is not reached on any path, because no path passes. The tie-break by C12 residue is not reached either.

**Whether a result changed.** No harness's result changed. Every path already failed a core cell before the regrade: `opencode run` and `opencode acp` C11, `agy -p` C1, `agy acp` C3, C5 and C11, and both `hermes` paths C11. The regrade touched none of those. It added failing cells to paths that already failed:

- `agy -p`: C3 and C11, so it now fails three of the four core cells instead of one.
- `agy acp`: C4, since the unprobed settings file no longer counts.
- `hermes headless`: C7 (no effort setting was run) and C9 (a failed shim shows only in the gateway log, as `agy -p` C9).
- `hermes acp`: C7 (no effort setter over ACP, as `opencode acp` C7).
- OpenCode's two paths are unchanged.

**OpenCode: none, by the rule as written.** Neither path passes. `opencode run` fails C11 and C7; `opencode acp` fails C11, C7 and C9. A supervisor that ends the tool's process groups would not by itself bring `opencode run` to the rule's bar: C7 fails too, because `--variant` is accepted silently on a model without variants and no run showed an effort applying. This conflicts with what is shipped: OpenCode is a working (A) kind with an opt-in end-to-end test (`test/e2e/opencode`). The escape of the bash tool's command was shown under `opencode acp` (oc Q12) and not probed under `opencode run` (open question 4). So `opencode run` C11 is `partly` for want of evidence, not because a process was seen to escape. This record removes nothing. Owner decision 2 asks whether the kind stays (A).

**`agy`: none.** `agy -p` fails C1, C3 and C11 (core), and C2, C7, C9 and C10. `agy acp` fails C3, C5 and C11 (core), and C2, C4, C6 and C9. `agy` stays reachable only as a user-supplied `runnerCommand`.

**`hermes`: none.** Both paths fail C11 (core): the gateway daemon runs the shim and every shell command in process groups of its own, and they outlive SIGTERM to the started group (hermes Q2). `hermes headless` also fails C2, C4, C7 and C9. `hermes acp` also fails C3 and C5 (core), and C2, C4, C6, C7 and C9.

**What would change a result.** These are not decisions. Each line names every cell that stands between a path and a pass, from the table above.

- `opencode run` would pass with three changes:
  - C11 `pass`: the probe of open question 4 shows that no command escapes, or a supervisor ends the tool's own process groups (tasks 2.9 and 2.7).
  - C7: a run that shows the effort applies, or a check that refuses a `--variant` the model does not have (task 2.24).
  - C10: its workaround was already run.
  It would be "priced" (C8 `pass`). `opencode acp` needs the same, plus C9, and its C8 is `fail`.
- `agy -p` would pass with six changes:
  - C1: accepts `--add-dir` with a directory that sorts after the worktree (agy Q4, `<scratch>/zz-launch`).
  - C3: a run in which a refused action comes back to the model and the turn goes on, for example under `--settings` rules (agy Q9, agy Q10).
  - C11: a probe of SIGTERM during a headless shell command shows that nothing is left (open question 11).
  - C2: a workaround, for example the shim announcing itself to the daemon when it starts. That also covers C9's gap.
  - C7: the effort is shown to apply.
  - C10: a way to keep the data out of `~/.gemini` headless.
- `hermes headless` would pass with four changes:
  - C11: the supervisor ends the gateway of the launch's own `HERMES_HOME` by the pid that home records (hermes Q2), together with the groups the gateway starts.
  - C2: a workaround, for example the shim announcing itself. That also covers C9's gap.
  - C4: a ruleset that refuses rather than hides, for example `command_allowlist`, not probed.
  - C7: a run that shows `--reasoning` applies.
- No ACP path is near a pass. `agy acp` needs a per-launch timeout that the probe did not find. `hermes acp` and `agy acp` both ask for permission on their own terms.

### 5. Residue of C12 per ACP path

These are the six items the criterion names, for each ACP path. `test/fixtures/acp/README.md` counts 6 of 6 for `opencode acp` itself. For `agy acp` and `hermes acp` the lists below are this record's mapping of the probe cells onto the six items, because those cells give no count. On every ACP path all six items remain per harness, so ACP saves no residue item over the six the criterion names.

- **`opencode acp`, 6 of 6** (oc Q2, oc Q4, oc Q14, oc Q15):
  1. The launch command, `opencode acp --pure`.
  2. The environment: `OPENCODE_CONFIG_CONTENT`, plus `HOME` and the XDG directories per launch.
  3. The configuration that makes it ask or stop asking: the permission ruleset in `OPENCODE_CONFIG_CONTENT`, and a disabled `mcp.orchestrator` entry that carries the timeout.
  4. The model setter: `model` in the configuration, or `session/set_config_option` with id `model`.
  5. The failure patterns: the stderr WARN `server unavailable` and -32602.
  6. The tool-name wording, `orchestrator_<tool>`.
- **`agy acp`, 6 of 6** (agy Q5, agy Q6, agy Q8, agy Q13, agy Q15):
  1. The launch command: `agy acp`, with `--gemini-dir` for a per-launch data directory.
  2. The environment: the user's `HOME` for the cached sign-in, since a scratch `HOME` has none (agy Q3).
  3. The configuration that makes it ask or stop asking: the client's answer to each request. `agy acp` has no `--settings`, and nothing tried lifted the 180 s cut.
  4. The model setter: `session/set_model` and the `thought_level` option.
  5. The failure patterns: -32000 `Authentication required` and -32602 `Unknown model ID`. A failed shim gives no pattern.
  6. The tool-name wording, `mcp_orchestrator_<tool>`. One more item has to be handled: the entry's env, persisted in agy's conversation store.
- **`hermes acp`, 6 of 6** (hermes Q2, hermes Q5, hermes Q13, hermes Q15):
  1. The launch command, `hermes acp`, and the lifecycle of its gateway daemon.
  2. The environment: a `HERMES_HOME` per launch, holding a copy of the credential files.
  3. The configuration that makes it ask or stop asking: `approvals.*` in that home's `config.yaml`. Its effect over ACP was not probed.
  4. The model setter: the home's `config.yaml`, or `session/set_model` with a `<provider>:<model>` id.
  5. The failure patterns: the -32603 `data.details` codes.
  6. The tool-name wording, `mcp__editor_orchestrator_<hash>__<tool>`.

### 6. Decisions left to the owner

Each decision lists its options, with the recommended option first.

1. **The rule itself.**
   - (a) Confirm the rule, and add a supervisor issue so that C11 can pass: the supervisor ends the process groups a launch's tools start, and for `hermes` the gateway of the launch's home. Re-grade C11 once that issue is built. For `opencode run` the supervisor alone is not enough: the path also fails C7, because `--variant` is accepted silently, and needs the C7 check of task 2.24 as well.
   - (b) Confirm the rule as it stands.
   - (c) Accept `partly` in C11 now.
2. **The shape for each harness.**
   - OpenCode:
     - (a) Keep the shipped (A) kind, against the rule's none. Its headless path fails C11, for want of a probe (open question 4), and C7, the silent `--variant`.
     - (b) Apply the rule and retire the kind.
     - (c) Move it to (B).
   - `agy`:
     - (a) None for now. Re-decide after the open questions on `--add-dir` placement and on C2 are answered.
     - (b) (A) with `--add-dir` after the worktree, and the shim announcing itself. Since the regrade, `agy -p` also fails C3 (the turn ends at a denial) and C11 (not probed under a shell command), so this option needs those two cells shown as well.
     - (c) (B).
   - `hermes`:
     - (a) None for now. Re-decide after the supervisor can end a home's gateway.
     - (b) (A) with a `HERMES_HOME` per launch and a gateway reaper. Since the regrade, `hermes headless` also fails C7 (`--reasoning` not run) and C9 (a failed shim only in the gateway log, covered by the shim announcement of task 2.8).
     - (c) (B).
3. **Go or no-go for each harness.**
   - `agy`: (a) no-go until it has a passing path; (b) go under shape (A) with the workarounds in decision 2.
   - `hermes`: (a) no-go until C11 passes; (b) go under shape (A) with a gateway reaper.
4. **The kind names.**
   - (a) `agy` and `hermes`, the CLI names, as `codex` and `opencode` are.
   - (b) `antigravity` and `hermes-agent`.
5. **The credential each new kind uses.**
   - `agy`:
     - (a) The cached sign-in under the user's `HOME`. It is the only credential the probe saw work, and it means writes under `~/.gemini` (C10).
     - (b) `GEMINI_API_KEY` with a scratch `HOME`. This was not probed.
   - `hermes`:
     - (a) A copy of the user's `~/.hermes/.env` and `auth.json` in the per-launch `HERMES_HOME`. The probe worked this way.
     - (b) A provider key in the launch environment. This was not probed.
6. **Do the three existing kinds move to the adapter contract before any new kind is built?**
   - (a) Yes. Lines 2.1 to 2.6, 2.10 and 2.11 of `tasks.md` are worth doing whatever the harness decisions are. The C11 gap was shown under `opencode acp`, and it is not probed under `opencode run`, the shipped kind.
   - (b) In parallel with the first new kind.
   - (c) No, a new kind is added as a fourth subclass.
7. **Does OpenCode get an ACP variant?**
   - (a) No. `opencode acp` fails C8 (last-step usage only, oc Q13), it saves no residue item, and it has the same C11 gap.
   - (b) Yes, as an opt-in control of an ACP driver (line 2.13 of `tasks.md`), only under shape (B).
8. **Which open questions become issues.**
   - (a) The C11 supervisor issue, the C2 shim announcement, the OpenCode headless C11 check, the OpenCode headless C7 check (task 2.24), and the `agy` and `hermes` re-probes listed under Open Questions. Each re-probe is tied to the decision it could change.
   - (b) Only the issues that a "go" under decision 3 needs.
   - (c) None for now.

## Risks / Trade-offs

- **ACP version 2 is a draft.** Every agent probed answered `protocolVersion: 1` (oc Q1, agy Q5, hermes Q5), and no probe ran a version 2 frame. A driver built on version 1 would have to follow the protocol when version 2 becomes final. The probes show nothing about what would change.
- **An agent that never asks makes the ACP permission policy idle.** Under (B), the driver answers `session/request_permission` from a per-launch policy. Several agents do not send that request for what matters:
  - `opencode acp` under `deny` and `allow` rules sends none (oc Q8).
  - `hermes acp` sent none for the heartbeat, the `block` call or a `sleep` (hermes Q11).
  `agy acp` is the other case: it asks on every MCP call and command (agy Q11), so there the policy answers everything and is not idle.
  So the real ruleset still lives in each harness's own configuration, which is residue item 3. The ACP policy only covers the actions the agent chooses to ask about. A policy that answers `reject_once` ends the turn in OpenCode and `agy` (oc Q9, agy Q11), so the worker cannot ask a `needsAccess` question. An unanswered request waits without end (oc Q9, agy Q11), so a driver needs its own timeout.
- **The rule can strip a shipped kind.** Applied as written, it gives OpenCode none: `opencode run` fails C11 and C7. Confirming the rule would leave a shipped kind that does not meet the record's own bar unless both are closed: the supervisor issue (task 2.7) or the probe of task 2.9 for C11, and the check of task 2.24 for C7. The supervisor issue alone does not bring OpenCode to the bar.
- **The grades come from three probes by three workers.** The probes used the same twelve criteria, but they read the evidence differently in places. The cells the review of 2026-11-20 found were graded again by the rule of section 2 (see Corrections). One reviewer should still re-check the cells that decide a path before a milestone is built on them.
- **Free models only.** OpenCode (`opencode/big-pickle`, a cost of 0 in every run, oc Q13) and `hermes` (`qwen/qwen4-max:free`, `estimated_cost_usd: 0`, hermes Q14) reported a cost of 0. `agy` reports no cost at all, headless or over ACP (agy Q14), and its README does not say whether `gemini-3.8-flash-low` is free. C8's "priced" cannot be checked against a real price on any path.
- **Process escapes may be a risk for every kind.** OpenCode's bash tool under `opencode acp` (oc Q12) and the hermes gateway (hermes Q2) both escape the started group. Under `opencode run`, the shipped kind, this was not probed (open question 4). If it holds there too, a shipped kind can leave processes after a launch is signalled.

## Open Questions

**The `not probed` cells.**

1. `agy acp` C6: does the agent commit in the linked worktree over ACP? Only the headless path was tried (agy Q12).
2. `hermes acp` C4: can a per-launch ruleset govern a session? Only the permission options were seen (hermes Q11).
3. `hermes acp` C6: does the agent commit over ACP? A commit was tried headless only (hermes Q12).

**Blocked answers.** No question of the three probes is answered `blocked`. Every answer is `yes` or `partly` (`answers.json` of each probe). These parts were dropped at a run cap or not tried, and are recorded inside `partly` cells:

4. `opencode run` C11: does the bash tool's command leave the group under `opencode run`, as it does under `opencode acp` (oc Q12)? This is one of the two facts that stop the headless path of the shipped kind. The other is C7: `--variant` is accepted silently on a model without variants (`test/fixtures/opencode/events/I1.jsonl`), and no run showed an effort applying (task 2.24).
5. `opencode acp` C9: what does a missing credential look like? It was not probed, because the free model needs no login (oc Q15).
6. `opencode acp` C7 and oc Q7: does `snapshots: false` and `share: disabled` apply? Where do the logs go without `--print-logs` (oc Q2)?
7. `agy -p` C1: is `--add-dir` with a directory that sorts after the worktree reliable? The probe showed one run each way (agy Q4). How does agy choose the directory commands run in?
8. `agy -p` C7: does `--effort` apply? Nothing shows it (agy Q13). `--mode` was not tried (agy Q10).
9. `agy acp` C4 and C5: does a settings file or an `mcp_config.json` entry with `timeoutSeconds` under a per-launch `--gemini-dir` give rules or lift the 180 s cut (agy Q8, agy Q10)?
10. `agy` C10: can `--include-default-customizations=false` or `--disable-slash-commands` stop the built-in skills being read? Does `GEMINI_API_KEY` work under a scratch `HOME` (agy Q3, agy Q16)?
11. `agy -p` C11: does SIGTERM during a headless shell command leave a process (agy Q16)? Since the regrade this gap makes the cell `partly`, a core failure.
12. `hermes acp` C5: does `timeouts.mcp.tool_call` in the per-launch home lift the 300 s cut (hermes Q8, run A8b dropped)?
13. `hermes acp` C3: does an unanswered request with `approvals.timeout: 30` resolve by itself (hermes Q11, run A11d dropped)?
14. `hermes headless` C3, C4: under `-z`, what happens to a dangerous absolute-path command (hermes Q9)? What do `--yolo`, `HERMES_YOLO_MODE=1`, `trust: full`, `command_allowlist` and `approvals.single_query_mode: approve` do (hermes Q10)? Does `--reasoning` apply (C7, hermes Q13)?
15. `hermes` C10: what does a turn read from its home (memory, `SOUL.md`, skills, plugins, `AGENTS.md`), and which switch turns each off? Do two model runs on one home both finish (hermes Q16, run H16 dropped)?
16. `hermes headless` C11: the 30 KB brief was not seen to end on its own (hermes Q3).

**Where the probes disagree, or a grade does not match its criterion.** 17 and 18 were regraded on 2026-11-20 by the grading rule of section 2; 19 and 20 remain.

17. `hermes headless` C9 was `pass`, although a failed shim shows only in the gateway log, while `agy -p` and `agy acp` C9 were `partly` for the same gap. Regraded `partly`, none run. It adds C9 to the cells `hermes headless` fails and changes no decision.
18. `agy -p` C3 was `pass`, but the turn ends at the auto-denial (agy Q9, H9b), while C3 asks that the run go on so the worker can ask `needsAccess`. Regraded `partly`, a core failure. It changes no decision, because `agy -p` already failed C1.
19. `agy acp` C1 is "pass with a residue": agy keeps the shim's env, token included, in `~/.gemini/antigravity-cli/conversations/<id>.db`. C1 forbids writing the user's configuration. Whether a conversation store counts as configuration is the owner's reading. The decision does not change, since `agy acp` fails C3, C5 and C11.
20. `opencode run` C10 is `partly`, from 4 of 23 starts that hit `database is locked` on a shared database. `opencode acp` C10 is `pass`, from 8 of 8 starts on a fresh database with no prompt sent. These conditions differ. Neither probe ran launches together on a busy database with prompts.

**Beyond these probes.**

21. Can Claude Code and Codex be reached over ACP? No probe on this machine may start `claude` or `codex`, so it is unknown whether either offers an ACP agent mode. Under (B) that matters for a single driver. Under (A) it does not.

**Added by the review of 2026-11-20.**

22. `agy -p` C11 was `pass`, although SIGTERM during a headless shell command was not probed (agy Q16), while `opencode run` C11 was `partly` for the same gap. Regraded `partly`, a core failure; see open question 11.
23. C4 and C7 counted an unprobed setting as a workaround on some paths and not on others: `agy acp` C4 (a settings file under `--gemini-dir`), `hermes acp` C7 (`session/set_model`, run only with an unknown id, while the effort option is empty) and `hermes headless` C7 (`--reasoning`, read from help). None of them counts now, as `hermes headless` C4 (`command_allowlist`) and `opencode acp` C7 (effort) did not count before.
24. Other `pass` cells were not re-examined by the rule; only the cells the review named were. These may hide an unprobed part: `agy acp` C7 (`thought_level` is offered in `configOptions`, but no run set it, agy Q13), `hermes headless` C3 (a dangerous absolute-path command under `-z` was not probed, open question 14) and `opencode acp` C10 (8 of 8 starts with no prompt sent, open question 20). Regrading any of them changes no result, since each path already fails a core cell.

## Corrections (2026-11-20)

The review of milestone 20 found the points below (#209). This record has no spec, so it was corrected in place; the first text is in the git history. One line per change:

- Section 2 states the grading rule above the table: a workaround counts only when the probe ran it, and a gap that was not probed grades `partly`.
- Context: the sentence that kept disagreeing cells unregraded now points to the rule.
- Section 3: a workaround for C2, C4, C6, C7, C9 or C10 counts only when the probe ran it.
- C3 `agy -p`: `pass` to `partly`, since the turn ends at the auto-denial (agy Q9, H9b); also in `test/fixtures/agy/README.md`.
- C11 `agy -p`: `pass` to `partly`, since SIGTERM during a headless shell command was not probed (agy Q16); also in `test/fixtures/agy/README.md`.
- C9 `hermes headless`: `pass` to `partly`, since a failed shim shows only in the gateway log (hermes Q7); also in `test/fixtures/hermes/README.md`.
- C4 `agy acp`: the unprobed settings file under `--gemini-dir` no longer counts as a workaround; also in `test/fixtures/agy/README.md`.
- C7 `hermes acp`: `session/set_model`, run only with an unknown id, no longer counts, and no effort setter was run; also in `test/fixtures/hermes/README.md`.
- C7 `hermes headless`: `--reasoning`, read from help only, no longer counts as an effort setting; also in `test/fixtures/hermes/README.md`.
- Section 4: the rule applied to all six paths again; no harness's result changed, and a paragraph says why and which failing cells were added.
- Section 4: "`agy -p` would pass with four changes" is now six (C3 and C11 added), and `hermes headless` needs four (C7 added).
- Section 4, decision 1 option (a), decision 2 options (b) for `agy` and `hermes`, and decision 8 option (a): `opencode run` fails C7 as well as C11, and the facts under each option follow the regrade.
- Risk "The rule can strip a shipped kind" and open question 4 name C7 as well as C11 for `opencode run`.
- Decision 6 (a): "Items 1 to 8" is now lines 2.1 to 2.6, 2.10 and 2.11 of `tasks.md`.
- Decision 7 (b): "item 10" is now line 2.13 of `tasks.md`.
- Risk "Free models only": it says which probes reported a cost of 0 (OpenCode, `hermes`) and that `agy` reports none, instead of "cost was 0 throughout".
- Risk on an agent that never asks: the examples are ACP paths (`opencode acp`, `hermes acp`), and `agy acp`, which asks on every call, replaces `agy` headless.
- Risk on three probes by three workers: the disagreeing cells were regraded.
- Open questions 17 and 18 record their regrades; new questions 22 and 23 record the regrade of `agy -p` C11 and of the C4 and C7 workarounds, and 24 lists `pass` cells not re-examined. Open questions 11 and 14 note the `agy -p` C11 and `hermes` `--reasoning` gaps.
- `tasks.md`: new line 2.24 for `opencode run` C7 (`--variant` accepted silently), S, blocked by a model with variants and the owner's decision 1.
- `tasks.md`: 2.14 is blocked by the shape (A) lines of 2a only (2.1 to 2.11 and 2.24), and 2.12 and 2.13 say that under shape (A) they are not built and do not block 2.14.
- Probe READMEs: each "For the decision record" section states the rule; `test/fixtures/hermes/README.md` gives the `<credential>` counts and no longer says the user name appears in `ls -l` output; the agy and Hermes READMEs describe the scrub of 2026-11-20 and its placeholders.
- Root `README.md` "Tests" (task 1.4 counted nine): ten opt-in tests, with `ORCH_E2E_OPENCODE_WORK=1 npm test -- test/e2e/opencode-work`.
