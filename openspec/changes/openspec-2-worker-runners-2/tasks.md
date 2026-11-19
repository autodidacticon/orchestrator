## 1. Split the last long requirement of `worker-runners`

- [x] 1.1 Restate "Codex runner command composition" under MODIFIED, with its header and all 3 scenarios unchanged and its description cut to one behavior (491 characters)
- [x] 1.2 Add each behavior moved out of it as an ADDED requirement named "Codex runner command composition: <behavior>" (template slots, MCP server overrides, approval string, launch environment), each with a description of at most 500 characters holding SHALL and a WHEN/THEN scenario grounded in a test or source file at the base
- [x] 1.3 List every moved sentence and the ADDED requirement that holds it in proposal.md, with each reference made explicit

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-worker-runners-2 --strict`
- [x] 2.2 Compare the scenarios of the MODIFIED requirement with the base spec; count SHALL and MUST before (10) and after (4 + 6 = 10)
- [x] 2.3 Archive into a copy of `openspec/` and validate `worker-runners --type spec --strict` there
