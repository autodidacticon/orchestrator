## 1. Facts and skill wording (this change)

- [x] 1.1 Probe codex-cli 0.170.0 and write `hosts/codex/README.md` "Workers in a Codex session", each fact with its command
- [x] 1.2 Codex run skill: state what the README found about subagents; in the pull-mode part, say how `runner.codex.ephemeral: false` keeps a worker's session and how to find a launch's session; the default stays `true`
- [x] 1.3 `orchestrator-work` prints each codex launch's thread id and whether its session is kept
- [x] 1.4 Tests: `test/host/codex-host.test.ts` pins the skill wording and the README section; `test/host/work-loop.test.ts` and `test/slice/codex-work.test.ts` cover the thread id line

## 2. Later: in-session Codex work loop (a later task, not this change)

- [ ] 2.1 Answer the open questions of `design.md` with codex probes, recorded in the README section
- [ ] 2.2 Write the `work` part of the Codex run skill: coordinator, `spawn_agent` per worker or per claimed launch, `wait_agent` loop, stop rule
- [ ] 2.3 Spec the loop in `host-integration` (a new requirement beside "Work skill and workflow") and test the skill wording
- [ ] 2.4 Run a pull-mode codex graph worked by an interactive Codex session end to end, opt-in like `test/e2e/codex-work.test.ts`
