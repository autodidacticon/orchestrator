## 1. Host files

- [x] 1.1 hosts/codex/bin/orchestrator.mjs (the launcher, its version from hosts/codex/package.json), hosts/codex/package.json, .gitignore
- [x] 1.2 hosts/codex/config.toml and hosts/codex/README.md
- [x] 1.3 hosts/codex/skills/{import,run,review}/SKILL.md

## 2. Wording

- [x] 2.1 WAIT_CAP_MS comment in src/operator/mcp-server.ts; operator-mcp "Wait tool" delta

## 3. Tests

- [x] 3.1 test/host/codex-host.test.ts
- [x] 3.2 test/slice/operator-mcp.test.ts: the wait description quotes the cap
- [x] 3.3 test/e2e/codex-operator.test.ts, run once against the real CLI

## 4. Manual check

- [x] 4.1 `codex mcp get orchestrator_operator` against both registration forms, recorded in design.md
