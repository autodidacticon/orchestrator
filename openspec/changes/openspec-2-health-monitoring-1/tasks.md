## 1. Split the long requirements of health-monitoring (part 1)

- [x] 1.1 Restate "Process liveness", "Progress signals", "Stuck detection and escalation", "Launch time budget" and "Usage accounting" under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior of at most 500 characters
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement named after its source requirement, with a description of at most 500 characters holding SHALL or MUST and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence, every reference made explicit and every lead-in in proposal.md, with the file behind each new scenario
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST count 71 before and at least 71 after
- [x] 1.5 `openspec validate openspec-2-health-monitoring-1 --strict` passes, and an archive in a copy of `openspec/` leaves no length warning on a requirement this change modifies or adds
