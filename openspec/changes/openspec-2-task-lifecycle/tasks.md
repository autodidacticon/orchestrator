## 1. Split the long requirements of `task-lifecycle`

- [x] 1.1 MODIFY each of the 11 long requirements: keep its header and every scenario, cut its description to one behavior of at most 500 characters
- [x] 1.2 ADD a requirement for each behavior moved out, with a new name, a description of at most 500 characters and a WHEN/THEN scenario based on a test or source file at the base
- [x] 1.3 Apply the owner's answer (block seq 2) to moved text without SHALL or MUST: list lead-ins, the OpenCode log sentences and the probe-facts lead-in
- [x] 1.4 List every moved sentence in the proposal with the requirement that holds it, and the source of every new scenario

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-task-lifecycle --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `task-lifecycle --type spec --strict` there
