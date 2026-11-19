## 1. Split the long requirements of toolchain-discovery

- [x] 1.1 Restate the eight long requirements under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior of at most 500 characters
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement with a new name, a description of at most 500 characters and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 Split the five sentences longer than 500 characters at their own joints, and list every moved sentence, split and lead-in in proposal.md
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST count 81 before and 94 after
- [x] 1.5 `openspec validate openspec-2-toolchain-discovery --strict` passes, and an archive in a copy of `openspec/` leaves `toolchain-discovery` valid under `--strict`
