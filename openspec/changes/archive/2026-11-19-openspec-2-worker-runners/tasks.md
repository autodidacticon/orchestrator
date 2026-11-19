## 1. Split the long requirements of `worker-runners`

- [x] 1.1 MODIFY "Runner kinds and defaults": keep header and scenarios, cut the description; add five requirements from the moved text
- [x] 1.2 MODIFY "Per-kind effort sets": keep header and scenarios, cut the description; add three requirements from the moved text
- [x] 1.3 MODIFY "Runner dispatch by launch kind": keep header and scenarios, cut the description; add three requirements from the moved text
- [x] 1.4 MODIFY "Sandbox and commit policy": keep header and scenarios, cut the description; add eight requirements from the moved text
- [x] 1.5 MODIFY "Codex usage parsing": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.6 MODIFY "OpenCode runner command composition": keep header and scenarios, cut the description, split the three sentences over the limit; add twenty-six requirements from the moved text
- [x] 1.7 MODIFY "OpenCode usage parsing": keep header and scenarios, cut the description; add three requirements from the moved text
- [x] 1.8 MODIFY "OpenCode e2e fixture recording": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.9 MODIFY "Codex network access override": keep header and scenarios, cut the description; add five requirements from the moved text
- [x] 1.10 List every moved sentence, each split and each added lead-in in the proposal, with the requirement that holds it

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-worker-runners --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `worker-runners --type spec --strict` there: only "Codex runner command composition", left to OS2, still warns
