## 1. Split the long requirements of agent-protocol (part 1 of 2)

- [x] 1.1 Restate "Standalone brief", "Submission sealing", "Acceptance evidence", "Block and wait", "Fallback file" and "MCP façade" under MODIFIED, each with its header and every scenario unchanged and its description cut to one behavior of at most 500 characters
- [x] 1.2 Add each behavior moved out of them as an ADDED requirement named "<MODIFIED name>: <behavior>", with a description of at most 500 characters holding SHALL or MUST and a scenario with WHEN and THEN, grounded in the code at the base commit
- [x] 1.3 List every moved sentence, split, lead-in and SHALL added at a joint, and the ADDED requirement that holds it, in proposal.md
- [x] 1.4 Check: the scenarios of each MODIFIED requirement equal the base; SHALL/MUST 76 before, 23 + 64 = 87 after
- [x] 1.5 `openspec validate openspec-2-agent-protocol-1 --strict` passes, and an archive in a copy of `openspec/` leaves no length warning on a requirement this change modifies or adds
