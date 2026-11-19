## 1. Split the long requirements of crash-recovery

- [x] 1.1 Restate the ten requirements over 500 characters under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement with a new name, a description of at most 500 characters and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence and the ADDED requirement that holds it in proposal.md
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST count 82 before and after; every sentence found once
- [x] 1.5 `openspec validate openspec-2-crash-recovery --strict` passes, and an archive in a copy of `openspec/` leaves `crash-recovery` valid under `--strict`
