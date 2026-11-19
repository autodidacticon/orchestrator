## 1. Split the long requirements of health-monitoring (part 2 of 2)

- [x] 1.1 Restate "Run cost budget", "Worktree observation takes no index lock", "Gap in the daemon's clock", "Hold after a gap" and "Limits read at every check" under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement named "<MODIFIED name>: <behavior>", with a description of at most 500 characters holding SHALL or MUST and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence, the ADDED requirement that holds it, the one split and the SHALL added at its joint in proposal.md
- [x] 1.4 Check: scenarios of each MODIFIED requirement equal the base; SHALL/MUST 57 before, 16 + 42 = 58 after
- [x] 1.5 `openspec validate openspec-2-health-monitoring-2 --strict` passes, and an archive in a copy of `openspec/` leaves no length warning on the requirements this change modifies or adds
