## 1. Workflow

- [x] 1.1 `hosts/claude-code/workflows/work.js`: read `claimModel` (default `'claude-haiku-5-5'`), `claimEffort` (default `'low'`, one of the five levels else the default), and `capacity` from `args`; clamp `workers` to `capacity` when given and `log()` the clamp
- [x] 1.2 `claimPrompt`: up to three polls per invocation; on 404 `wait` with `until: "any"` and `timeoutMs: 90000`, then `status`, evaluate the unchanged stop rule, and claim again while polls remain and `stop` is false; return the same structured shape
- [x] 1.3 The claimer `agent()` call passes `model: claimModel`, `effort: claimEffort`, and label `` `claim ${workerId}` ``; the worker call's label becomes `` `work ${workerId} ${c.taskId}` ``; `meta.description` and `whenToUse` mention the cheap claimer

## 2. Skills

- [x] 2.1 `hosts/claude-code/skills/work/SKILL.md` section 2: the Workflow call passes `capacity` from `status`; document `claimModel` and `claimEffort` with their defaults and that they are passed only when the user asks; describe the labels so the user can relate claims to work
- [x] 2.2 `hosts/claude-code/skills/run/SKILL.md` section 1a: the same Workflow call with `capacity`, one sentence on the claimer defaults and labels

## 3. Tests and finish

- [x] 3.1 `test/host/package.test.ts`: assert `work.js` contains the claimer defaults (`claude-haiku-5-5`, `low`), passes `model: claimModel` and `effort: claimEffort` on the claimer call, uses the `claim ${workerId}` and `work ${workerId} ${c.taskId}` labels, clamps to `capacity`, and that both skills mention `claimModel`; the claim prompt mentions `90000` and three polls
- [x] 3.2 `npm test` green; `openspec validate tune-work-workflow`; the opt-in `ORCH_E2E_CLAUDE_WORK=1 npm test -- test/e2e/work` is the real-session check and is run when a logged-in `claude` is available. Found: the real-session test failed because `acceptEdits` auto-approves edits only inside the working directory and `--add-dir` directories while worktrees live under `ORCH_HOME`; fixed by passing `--add-dir <ORCH_HOME>` in the test session and documenting the prompt in both skills (one sentence added to the spec delta). `test/slice/launch.test.ts` "missing acceptance evidence fails the submission" failed once in the full run and passed alone; it is the known load flake, not a regression
