## 1. Split the long requirements of remote-workspace

- [x] 1.1 Restate "Remote workspace" and "Seal" under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement with a new name, a description of at most 500 characters and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence and the ADDED requirement that holds it in proposal.md
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST count 21 before and after
- [x] 1.5 `openspec validate openspec-2-remote-workspace --strict` passes, and an archive in a copy of `openspec/` leaves `remote-workspace` valid under `--strict`
