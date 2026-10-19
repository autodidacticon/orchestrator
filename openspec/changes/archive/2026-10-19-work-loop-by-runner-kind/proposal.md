## Why

Pull mode has no opencode worker: an opencode run in pull mode parks every launch. Copying the loop a second time would double the drift surface the Codex host already carries for launchers and skills.

## What Changes

1. hosts/codex/bin/work.mjs becomes kind-parameterized and keeps its path (the published bin stays `orchestrator-work`): `--runner <codex|opencode>` (default codex, so existing invocations are unchanged); `packageModules()` resolves `src/runner/<kind>.ts` / `dist/src/runner/<kind>.js`; the stop rule and the claim filter use the chosen kind; the preamble is per kind (tool names `orchestrator_<tool>` for opencode, the 401 rule shared); the per-launch step calls a small per-kind adapter: `compose(launch, claim)`, `prepare(launch, env)` (codex: `writeCodexShimEnv`; opencode: write `.orchestrator/opencode.json` 0600 and return the env additions `OPENCODE_CONFIG_CONTENT`, optional `XDG_DATA_HOME`/`XDG_CONFIG_HOME`), `parseUsage(log)`, `classifyFailure(log)`. Both adapters import from the package modules the runner issues export (`composeOpenCodeCommand`, `openCodeConfig`, `parseOpenCodeUsage`, `classifyOpenCodeFailure`).
2. The claim response carries `opencode: { settings, allowedTools, maxWaitMs, retryWindowMs }` for an opencode launch (beside the codex block), so the loop composes exactly what a spawned launch gets, including the derived permission ruleset.
3. hosts/opencode/README.md gets the pull-mode section (`orchestrator-work --runner opencode --workers 2`), and the OpenCode skills' start-mode rule drops the "until a work loop exists" wording, as the Codex work-loop change did for the Codex host.
4. test/e2e/opencode-work.test.ts behind `ORCH_E2E_OPENCODE_WORK=1`: a pull-mode run with the free model drained by `--runner opencode --workers 2`; every launch has `worker` and no `pid`, tokens with `source: worker`, three trailers on the integration branch. A fake-runner slice test (no model) drives the loop with a fake `opencode` on PATH that echoes stdin and prints a recorded JSONL, asserting the config env, the stdin redirect and the posted usage.

## Capabilities

- `host-integration`: modified: "Codex host", "OpenCode host", "Work loop by runner kind"; renamed: "Codex work loop" to "Work loop by runner kind"
- `pull-runner`: modified: "Claim", "Worker usage"

## Impact

* hosts/codex/bin/work.mjs, hosts/opencode/README.md, hosts/opencode/skills/run/SKILL.md, hosts/opencode/skills/import/SKILL.md
* src/loop/orchestrator.ts (claim response), src/operator/routes.ts if the claim body is typed there
* test/host/work-loop.test.ts (new slice test), test/e2e/opencode-work.test.ts (new)

## Record

Reconstructed at archive time on 2026-10-19. The worker for ORC-64 edited `openspec/specs` directly in commit 072a663 instead of writing a change directory; the deltas below are computed from what that commit did to each requirement block, and this proposal and the task list come from the ORC-64 issue text.

Commit summary: hosts/codex/bin/work.mjs is now the work loop by runner kind. `--runner <codex|opencode>` (default codex) selects the kind; packageModules(kind) resolves src/runner/<kind>.ts or dist/src/runner/<kind>.js. The stop rule, the claim filter, the preamble, the log and prompt file names and all log lines use the kind. One per-kind adapter (makeAdapter) holds block/prepare/compose/started/parseUsage/classifyFailure. The opencode adapter builds openCodeConfig(settings, allowedTools, maxWaitMs), writes it through prepareOpenCodeLaunch (0600 opencode.json) and returns OPENCODE_CONFIG_CONTENT (plus XDG_* when the settings ask for them) into the child env beside the claim's agent env, so the shim gets its identity with no env file. It then runs composeOpenCodeCommand ... < .orchestrator/opencode-work-prompt.md. A start with no events (exitBeforeTurn or startupContended) is released with keep: true. The daemon's claim response carries opencode: { settings, allowedTools, maxWaitMs, retryWindowMs, env } for an opencode launch; allowedTools comes from a new Orchestrator.openCodeAllowedTools(), which openCodePermissionFor() now uses too. Worker usage posts the opencode cost as costUsd when it is above zero. The OpenCode README has a pull-mode section and the OpenCode run skill offers `--runner opencode` instead of saying no loop exists. The host-integration requirement is renamed "Work loop by runner kind", with three new scenarios; OpenCode host is updated; pull-runner Claim gains the opencode block plus a scenario, and Worker usage gains an opencode scenario. Commits abfe81e and 681a2ae.
