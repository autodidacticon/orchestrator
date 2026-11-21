## 1. Decision record (this change)

- [x] 1.1 Read "For the decision record", the numbered answers and `results.json` of `test/fixtures/acp/README.md`, `test/fixtures/agy/README.md` and `test/fixtures/hermes/README.md`, without running any CLI or model
- [x] 1.2 Write `design.md`. It holds the context per harness and the criteria table (C1 to C12 against six paths). It gives the decision per harness, with the rule applied step by step, and the C12 residue per ACP path. It lists the owner's decisions, the risks and the open questions.
- [x] 1.3 Write `proposal.md` and `.openspec.yaml` (`schema: spec-driven`, `skip_specs: true`, no `specs/`)
- [x] 1.4 `README.md` "Tests": count nine opt-in tests that use a real model, and name `ORCH_E2E_ACP_OPENCODE=1 npm test -- test/e2e/acp-opencode`
- [x] 1.5 `openspec validate harness-integration-shape --strict`. Then, in a copy of `openspec/`, run `openspec archive harness-integration-shape --yes` and `openspec validate --specs --strict`.

## 2. Later

This section lists issues for later milestones. None is built by this change. Each line gives a size (S, M, L) and what blocks it. "(B only)" marks a line that exists only under shape (B). The rule gives no harness shape (B), so the (B only) lines apply only if the owner chooses (B) at the review. Lines marked "(from the probes)" were added after the probes; the others were known on 2026-11-20. Line 2.24 was added by the review of 2026-11-20.

### 2a. Milestone "Harness adapter and supervisor"

- [ ] 2.1 A kind registry: one descriptor per kind, read by `RUNNER_KINDS`, the tables of `src/runner/selection.ts` and `zeroByKind`. No behaviour change. (M; blocked by: the owner's decision 6, the contract before new kinds)
- [ ] 2.2 One harness adapter and one adapter runner in place of the three `SubprocessRunner` subclasses. `src/main.ts` builds the `MultiRunner` from the registry. (L; blocked by 2.1)
- [ ] 2.3 Config, overrides and operator surfaces built from the registry: `src/config.ts`, `src/runs/resolve.ts`, the CLI and the MCP tool schemas. (L; blocked by 2.1)
- [ ] 2.4 Brief text and the work loop's preamble come from the descriptor, with `test/fixtures/brief/*.md` unchanged. (M; blocked by 2.1)
- [ ] 2.5 The claim answer carries one neutral `harness` block. The `codex` and `opencode` keys stay for older loops. (S; blocked by 2.2)
- [ ] 2.6 One supervisor, extracted from `hosts/codex/bin/work.mjs` and `src/worker/loop.ts`, tested with fake time. (L; blocked by: nothing)
- [ ] 2.7 (from the probes, C11) The supervisor ends the process groups a launch's tools start, not only the group it started: OpenCode's bash tool runs its command in a group of its own (oc Q12), and a per-home daemon such as the `hermes` gateway is ended by the pid its home records (hermes Q2); tested with a fake agent that starts a detached grandchild. (M; blocked by 2.6, and by the owner's decision 1)
- [ ] 2.8 (from the probes, C2) The shim announces itself to the daemon when it starts. A launch whose shim never announced is classified `mcpStartupFailed`, whatever the harness printed. This covers `agy` and `hermes`, where a failed shim is silent (agy Q7, hermes Q7). (M; blocked by: the owner's decision 8)
- [ ] 2.9 (from the probes, open question 4) Probe whether the bash tool's command of `opencode run` leaves the process group. Record it in `test/fixtures/opencode/README.md` and re-grade `opencode run` C11. (S; blocked by: nothing)
- [ ] 2.10 `orchestrator-work` runs on the adapter and the supervisor. (M; blocked by 2.2, 2.5 and 2.6)
- [ ] 2.11 `orchestrator-worker` runs on the adapter and the supervisor. In remote mode it prepares through the adapter, and it posts the kind's usage. (L; blocked by 2.2, 2.5 and 2.6)
- [ ] 2.12 (B only; under shape (A) it is not built and does not block 2.14) The ACP driver as an executable, built from the client of #197 (`test/fixtures/acp/acp-client.mjs`). It needs its own timeout for an unanswered `session/request_permission`, and it never answers with `reject_once` (see Risks). (L; blocked by 2.2, and by a (B) decision)
- [ ] 2.13 (B only; under shape (A) it is not built and does not block 2.14) The `acp` adapter and its configuration block, with OpenCode over ACP as an opt-in control. (M; blocked by 2.3 and 2.12, and by the owner's decision 7)
- [ ] 2.14 The owner runs the existing opt-in real-CLI tests, and they pass unchanged. (S; blocked by the shape (A) lines of 2a: 2.1 to 2.11 and 2.24, so it runs last; under shape (B) also by 2.12 and 2.13)
- [ ] 2.24 (from the review of 2026-11-20, C7) `opencode run` C7: `--variant` is accepted silently on a model without variants (`test/fixtures/opencode/events/I1.jsonl`), so no run shows an effort applying. Check the effort before launch against the variants the model offers (or refuse it), probe a model that has variants, record it in `test/fixtures/opencode/README.md`, and re-grade `opencode run` C7. Numbered 2.24 so that no earlier line moves. (S; blocked by: a model with variants that the probe may run, and the owner's decision 1)

### 2b. Milestone "Antigravity and Hermes workers"

The rule gives both harnesses none. Every line in this section is blocked by a "go" under the owner's decision 3 for that harness, and by the shape the owner chooses under decision 2. The lines below assume shape (A), the shape of the "what would change a result" notes in `design.md`.

`agy`:

- [ ] 2.15 The `agy` kind: descriptor, config block, model shape (every slug fits `MODEL_PATTERN`, agy Q13), effort set, default model and commit policy default. (M; blocked by 2.1, and by go for `agy`)
- [ ] 2.16 The `agy` adapter: `agy -p` with the prompt as one `--input-format stream-json` user message, the shim registered per launch by `--add-dir` on a directory outside the worktree, `--settings` permission rules, `timeoutSeconds` on the entry, a usage parser (input excludes cache reads, no cost), a failure classifier (exit codes 1, 2 and 3, `AGY_ERROR`) and fixtures from `test/fixtures/agy/`. (L; blocked by 2.2, 2.15, 2.8, and open questions 7 and 8)
- [ ] 2.17 `agy` brief fragments and operator surfaces. The tools are reached through `call_mcp_tool` headless (agy Q6). (M; blocked by 2.3, 2.4 and 2.15)
- [ ] 2.18 An `agy` slice test with a fake CLI, and an opt-in test with the real one. (M; blocked by 2.16 and 2.17)

`hermes`:

- [ ] 2.19 The `hermes` kind: descriptor, config block, a model pattern for `<vendor>/<model>:<tag>` names (they fail `MODEL_PATTERN`, hermes Q13), effort set (`--reasoning`), default model and commit policy default. (M; blocked by 2.1, and by go for `hermes`)
- [ ] 2.20 The `hermes` adapter: `hermes chat --query-file ... --format stream-json` (or `-z` with `--usage-file`), a `HERMES_HOME` per launch holding `mcp_servers.orchestrator` with `timeout` and `approvals.mode: off`, the credential copy by the owner's decision 5, the gateway ended through 2.7, a usage parser (input includes the cache, an estimated cost), a failure classifier, fixtures from `test/fixtures/hermes/`, and the hardline guard on relative `rm` arguments in the brief (hermes Q9). (L; blocked by 2.2, 2.7, 2.8, 2.19, and open questions 14 and 15)
- [ ] 2.21 `hermes` brief fragments and operator surfaces. The tool names are `mcp__orchestrator__<tool>`, reached after `tool_search` or `tool_describe` (hermes Q6). (M; blocked by 2.3, 2.4 and 2.19)
- [ ] 2.22 A `hermes` slice test with a fake CLI, and an opt-in test with the real one. (M; blocked by 2.20 and 2.21)

Both:

- [ ] 2.23 Documentation for both kinds: README, run skills, credentials and isolation notes. (S; blocked by 2.18 and 2.22)
