## 1. Split the long requirements of `tracker-sync`

- [x] 1.1 MODIFY "Durable outbox", "Tracker policy", "State effects", "Done semantics", "Comment effects" and "Drainer contract": keep headers and scenarios, cut the descriptions
- [x] 1.2 ADD a requirement for each moved behavior, with a scenario backed by a test at the base
- [x] 1.3 Split the long first sentence of "Comment effects" at its semicolons, repeating its lead-in
- [x] 1.4 List every moved sentence in the proposal with the requirement that holds it

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-tracker-sync --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `tracker-sync --type spec --strict` there
