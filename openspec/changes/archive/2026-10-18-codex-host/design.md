## Decisions

**A copied launcher with one changed line, not a hosts/common/ module.** The launcher must be dependency-free and must locate its host directory from its own URL. A shared module would need a relative import across host directories, and that breaks when one host directory is copied on its own. The copy differs only in the npx version source: `<host>/package.json` `dependencies["@autodidacticon/orchestrator"]` instead of `.claude-plugin/plugin.json` `version`. test/host/codex-host.test.ts asserts that the code lines differ only there, so the two copies cannot drift unnoticed. The Claude Code launcher is unchanged.

**`tool_timeout_sec = 180` in the template.** It matches the Claude Code `.mcp.json` timeout of 180 000 ms and exceeds `ceil(WAIT_CAP_MS/1000) + 30` = 120 s. That leaves headroom for `launch_block`, which waits up to the cap, and for the round trip of a revived daemon.

**`codex mcp add` with a lowered cap as the alternative.** `codex mcp add` has no flag for `tool_timeout_sec`, as the probe below shows (`tool_timeout_sec: null`). An entry it writes runs at Codex's 60 s default. `ORCH_WAIT_CAP_MS` already lowers both the cap and the `wait` default (`WAIT_DEFAULT_MS = min(60 000, cap)`), so a value below 60 000 keeps every call under the default with no code change. The README uses 30 000.

**The underscore id `orchestrator_operator`.** Tool names are `mcp__<id>__<tool>`, and hyphenated ids in tool names were not observed in the Codex probes. The e2e's JSONL shows `server: "orchestrator_operator"` on every `mcp_tool_call` item.

**Skill names `orchestrator-import`, `orchestrator-run`, `orchestrator-review`.** `~/.codex/skills/` is one flat namespace, and names such as `review` and `run` are generic enough to collide with skills from other sources. The directory names under hosts/codex/skills stay `import`, `run` and `review`. The README links each one under its prefixed name.

**Spawn by default.** The Codex host has no subagents. A `start` without `mode` on a `claude-code` run lands in `pull` and parks every launch for workers that do not exist. An explicit `mode` overrides `runner.mode` in the file (`--mode` sets the store's `runner.mode`) and is applied to a running daemon through `PUT /v1/runner` (src/runs/lifecycle.ts). Passing it unconditionally would therefore override the repository's choice, and would flip a run that a Claude Code session is working in `pull`. The Codex skills check first. They call `start` with `mode: "spawn"` only when no daemon is running and `orchestrator.yaml` sets no `runner.mode`; otherwise they call `start` without `mode`. When the run is `pull` and another session holds launches (`status.attachments`), they leave it alone; otherwise they say so and offer `spawn`. This holds until a Codex work loop lands.

**`needsAccess` per runner.** For a `codex` launch the skill offers a sandbox change (`configure` with `sandbox`) for later launches, matching the brief's codex wording. For a spawned `claude-code` launch it offers an `allowedTools` rule. Running the command and answering stays the way to unblock the live agent.

## Deviations

- "Skills report the toolchain" is not re-stated. The unarchived change operator-runner-kind already modifies it. The Codex edition's toolchain rules (always name the kind, `AGENTS.md` first) are in the new "Codex host" requirement instead, so the two changes do not carry competing full texts of one requirement.
- `test/e2e/codex-operator.test.ts` is not in the brief's file list; it is the opt-in e2e of acceptance criterion 5.
- The comment on `WAIT_CAP_MS` in src/operator/mcp-server.ts is reworded to match the spec. There is no code change.
- `openspec/specs/` is not edited, as in ORC-49; the deltas are in this change.

## Manual check: `codex mcp get orchestrator_operator` (codex-cli 0.163.0, 2026-10-18)

Both forms were registered in a scratch `CODEX_HOME`, so the user's `~/.codex/config.toml` was not touched. `<worktree>` stands for the checkout path.

Template form: hosts/codex/config.toml with `<hosts/codex>` replaced, written as `$CODEX_HOME/config.toml`:

```
orchestrator_operator
  enabled: true
  transport: stdio
  command: node
  args: <worktree>/hosts/codex/bin/orchestrator.mjs mcp
  cwd: -
  env: -
  startup_timeout_sec: 30
  tool_timeout_sec: 180
  remove: codex mcp remove orchestrator_operator
```

`codex mcp list` shows `orchestrator_operator  node  <worktree>/hosts/codex/bin/orchestrator.mjs mcp  -  -  enabled  Unsupported`.

`codex mcp add` form: `codex mcp add orchestrator_operator --env ORCH_WAIT_CAP_MS=45000 -- node <worktree>/hosts/codex/bin/orchestrator.mjs mcp` printed `Added global MCP server 'orchestrator_operator'.` and wrote:

```toml
[mcp_servers.orchestrator_operator]
command = "node"
args = ["<worktree>/hosts/codex/bin/orchestrator.mjs", "mcp"]

[mcp_servers.orchestrator_operator.env]
ORCH_WAIT_CAP_MS = "45000"
```

`codex mcp get orchestrator_operator` then showed `enabled: true`, `transport: stdio`, `command: node`, the same args, and `env: ORCH_WAIT_CAP_MS=*****`. `--json` showed `"tool_timeout_sec": null` and `"startup_timeout_sec": null`.

test/host/codex-host.test.ts repeats the template form with `--json` whenever `codex` is on PATH.

## Probe: the operator tools answer in `codex exec`

`ORCH_E2E_CODEX_OPERATOR=1 npx vitest run test/e2e/codex-operator.test.ts` passed in 94 s on its first run (gpt-6-astra at low, `-s read-only`, `--ignore-user-config --ephemeral`). The server was registered with `-c mcp_servers.orchestrator_operator.*` overrides that mirror the template, `required=true`, and `env={ORCH_HOME, ORCH_REPO, PATH, HOME}`. The approvals were `approval_policy="never"`, `default_tools_approval_mode="approve"`, and a per-tool `approval_mode="approve"` for all 31 operator tools, the approval keys of the Codex runner (ORC-47).

Codex called `start` (`mode: spawn` in the result), `import_graph`, `wait` in a loop, and `answer` for T1's `blockAndWait` question. The run reached `digest.finished: true`, and `main:T1.txt` holds the answer.
