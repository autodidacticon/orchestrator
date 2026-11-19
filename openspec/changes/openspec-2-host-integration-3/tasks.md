## 1. Split the last long requirements of host-integration

- [x] 1.1 Restate "Codex host" and "Work loop by runner kind" under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior of at most 500 characters
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement named "<MODIFIED name>: <behavior>", with a description of at most 500 characters holding SHALL or MUST and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence, every reference made explicit, and the ADDED requirement that holds it, in proposal.md
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST count 65 before and after
- [x] 1.5 `openspec validate openspec-2-host-integration-3 --strict` passes, and an archive in a copy of `openspec/` leaves `host-integration` valid under `--strict`
