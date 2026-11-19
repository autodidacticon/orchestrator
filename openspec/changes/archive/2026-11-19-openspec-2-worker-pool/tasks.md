## 1. Split the long requirements of worker-pool

- [x] 1.1 Restate "Worker loop", "Clone cache", "Agent command", "Scripted agent", "Loop heartbeat" and "Task filter and launch limit" under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement named "<MODIFIED name>: <behavior>", with a description of at most 500 characters and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence and the ADDED requirement that holds it in proposal.md
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST count 41 before and after
- [x] 1.5 `openspec validate openspec-2-worker-pool --strict` passes, and an archive in a copy of `openspec/` leaves `worker-pool` valid under `--strict`
