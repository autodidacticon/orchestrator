## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. One of the 68 requirements of `worker-runners` is still over the limit: "Codex runner command composition", which `openspec-2-worker-runners` (OS1) left for this migration. This change splits it the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (#139, task GH-178), based on commit 8125a96.

## What Changes

- MODIFIED "Codex runner command composition": its header and all 3 scenarios are kept, names and text unchanged. Its description is cut to one behavior, the command it spawns and the flags that template may hold: 1930 characters before, 491 after (measured as OpenSpec 2.1 measures them, non-blank lines trimmed and joined by newlines; the Facts of the brief give the raw text, 1936).
- 4 ADDED requirements hold the moved text. Each is named "Codex runner command composition: <behavior>", a name `worker-runners` does not have at the base, has a description of at most 500 characters that holds SHALL, and has scenarios of its own with WHEN and THEN steps:

  | ADDED requirement | Length | SHALL/MUST | Scenario grounded in |
  |---|---|---|---|
  | Codex runner command composition: template slots | 487 | 1 | `test/runner/codex.test.ts` "follows the runner.codex keys" and "composes the verified flags ..." (no `{...}` left); `codexSlots` in `src/runner/codex.ts` |
  | Codex runner command composition: MCP server overrides | 408 | 1 | `test/runner/codex.test.ts` "follows the runner.codex keys" (`startup_timeout_sec=5`), "sizes the tool timeout a minute above maxWaitMs" (`tool_timeout_sec=151`), "composes the verified flags ..." (the `args` with `--orch-env-file`, no `network_access`) |
  | Codex runner command composition: approval string | 318 | 2 | `test/runner/codex.test.ts` "the shell hands codex each -c value as one TOML word" |
  | Codex runner command composition: launch environment | 289 | 2 | `test/runner/codex.test.ts` "writes the shim env file 0600 with the four ORCH_ variables and runs the composed command"; for `CODEX_HOME`, the source: `CodexRunner.spawn` and `writeCodexShimEnv` in `src/runner/codex.ts` set none; `SubprocessRunner.spawn` in `src/runner/subprocess.ts` gives the child `process.env`, `extraEnv`, the launch's agent environment and `ORCH_LOG`; `src/main.ts` builds the `CodexRunner` with no `extraEnv`; and `agentEnv` in `src/loop/orchestrator.ts` (with `isolationEnv` in `src/runs/childEnv.ts`) adds only `ORCH_*` variables |

- No requirement or scenario is removed or renamed, and no SHALL or MUST is dropped or weakened: the original description holds 10; the cut description holds 4 and the ADDED ones 6 (10 in all).
- The other 67 requirements of `worker-runners` are not touched, and no file outside this change directory changes. The change is archived after the milestone review.

### Splits, lead-ins and SHALL at a joint

None. No sentence of the original description is over 500 characters on its own (measured with a script: the longest unit is the slots sentence with its four items, 451 characters; then the overrides lead-in with its five items, 389; the longest single sentence without a list is "Otherwise it SHALL be ...", 246), so no sentence is split. Both lists move whole with their own lead-in sentences ("At every spawn the runner SHALL fill the slots ...:" and "The overrides SHALL set:"), so no bullet moves without its lead-in and no lead-in is added. Every moved sentence already holds SHALL, so no SHALL is given at a joint. The only changes of wording are references made explicit, listed below.

## Moved sentences: "Codex runner command composition"

Sentences are numbered from 1 in the original description; a list item counts as one. *Unchanged* means word for word.

- 1 "The Codex runner SHALL spawn `DEFAULT_CODEX_COMMAND`, or `runner.codex.command` when it is set:" stays, unchanged.
- 2 The template line "`codex exec --json {ephemeral} ... - < {brief}`" stays, unchanged.
- 3 "The template SHALL use only flags verified against the Codex CLI." stays, unchanged.
- 4 "It SHALL NOT contain `--full-auto` or `--dangerously-bypass-approvals-and-sandbox`, and it SHALL have no `{allowedTools}` slot." stays, unchanged.
- 5 "At every spawn the runner SHALL fill the slots from the effective `runner.codex`:" moves to **Codex runner command composition: template slots**, with "the runner" made explicit as "the Codex runner" and "the slots" as "the slots of the Codex command template": "At every spawn the Codex runner SHALL fill the slots of the Codex command template from the effective `runner.codex`:".
- 6 "- `{sandbox}` with `sandbox`;" moves to **Codex runner command composition: template slots**, unchanged.
- 7 "- `{ephemeral}` with `--ephemeral` when `ephemeral` is true (the default), and otherwise with nothing;" moves to **Codex runner command composition: template slots**, unchanged.
- 8 "- `{ignoreUserConfig}` with `--ignore-user-config` when `ignoreUserConfig` is true (the default), and otherwise with nothing;" moves to **Codex runner command composition: template slots**, unchanged.
- 9 "- `{codexOverrides}` with `-c` overrides that register the orchestrator shim as the MCP server `orchestrator`." moves to **Codex runner command composition: template slots**, unchanged.
- 10 "The overrides SHALL set:" moves to **Codex runner command composition: MCP server overrides**, with "The overrides" made explicit as "The `{codexOverrides}` overrides": "The `{codexOverrides}` overrides SHALL set:".
- 11 "- `command` and `args`: the shim entrypoint followed by `--orch-env-file <worktree>/.orchestrator/shim.env`;" moves to **Codex runner command composition: MCP server overrides**, unchanged.
- 12 "- `required=true`;" moves to **Codex runner command composition: MCP server overrides**, unchanged.
- 13 "- `startup_timeout_sec`: `startupTimeoutSec`, default 30;" moves to **Codex runner command composition: MCP server overrides**, unchanged.
- 14 "- `tool_timeout_sec`: `toolTimeoutSec`, default `ceil(maxWaitMs/1000)+60`;" moves to **Codex runner command composition: MCP server overrides**, unchanged.
- 15 "- the approval string, then `sandbox_workspace_write.network_access=true` when `networkAccess` is true." moves to **Codex runner command composition: MCP server overrides**, unchanged.
- 16 "The approval string SHALL be `runner.codex.mcpApproval` when it is set." moves to **Codex runner command composition: approval string**, unchanged.
- 17 "Otherwise it SHALL be `approval_policy="never"`, ... for each of `heartbeat`, `report`, `block`, `inbox`, and `log`." moves to **Codex runner command composition: approval string**, unchanged (its "Otherwise it" points at sentence 16, which moves with it).
- 18 "Before spawning, the runner SHALL write `.orchestrator/shim.env` with mode 0600, holding ... (and `ORCH_COMMIT_POLICY` when the launch has the `daemon` policy)." moves to **Codex runner command composition: launch environment**, with "the runner" made explicit as "the Codex runner".
- 19 "The runner SHALL NOT set `CODEX_HOME` per launch." moves to **Codex runner command composition: launch environment**, with "The runner" made explicit as "The Codex runner".

The scripted check finds sentences 1 to 4, 6 to 9, 11 to 17 word for word in exactly one requirement, and prints sentences 5, 10, 18 and 19, the four whose references are made explicit above, as not found word for word.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `worker-runners`: "Codex runner command composition" is cut to one behavior of at most 500 characters, and the behaviors moved out of it become four ADDED requirements named "Codex runner command composition: <behavior>". What the spec requires does not change.

## Impact

Only `openspec/changes/openspec-2-worker-runners-2/`. No code, test or other spec changes. After the archive, `openspec validate worker-runners --type spec --strict` has no length warning left.
