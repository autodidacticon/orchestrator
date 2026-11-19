## 1. Split the long requirements of host-integration (part 2)

- [x] 1.1 Copy each of the 12 requirements whole from `openspec/specs/host-integration/spec.md` under MODIFIED, then cut its description to one behavior of at most 500 characters
- [x] 1.2 Add each removed behavior as an ADDED requirement with a new name, a description of at most 500 characters, and a scenario that has WHEN and THEN, backed by a file named in the proposal
- [x] 1.3 Compare the scenarios of each MODIFIED requirement with the base spec, and count SHALL and MUST before and after
- [x] 1.4 `openspec validate openspec-2-host-integration-2 --strict`, plus an archive trial in a copy of `openspec/`
