## 1. Split the long requirements of `operator-control` (part 2 of 2)

- [x] 1.1 MODIFY the 12 long requirements listed in the proposal: keep each header and every scenario, cut each description to one behavior of at most 500 characters
- [x] 1.2 ADD one requirement for each behavior moved out, each with its own WHEN/THEN scenario backed by code or a test at the base
- [x] 1.3 Split the four sentences over 500 characters at their semicolons, and list every moved sentence in the proposal with the requirement that holds it

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-operator-control-2 --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `operator-control --type spec --strict` there
