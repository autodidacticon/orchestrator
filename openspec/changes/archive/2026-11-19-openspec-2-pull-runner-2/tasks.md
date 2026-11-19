## 1. Split the long requirements of pull-runner (part 2 of 2)

- [x] 1.1 Restate the 7 requirements of part 2 (Session attachments, Worker usage, Lease expiry, Silence limit in the claim, Lease renewal after a gap, Prepare failure limit, Remote run requirements) under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement named "<requirement>: <behavior>", with a description of at most 500 characters that holds SHALL or MUST and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence, and each reference made explicit, with the ADDED requirement that holds it, in proposal.md
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST 64 before and 64 after
- [x] 1.5 `openspec validate openspec-2-pull-runner-2 --strict` passes, and an archive in a copy of `openspec/` leaves no length warning on a requirement this change modifies or adds
