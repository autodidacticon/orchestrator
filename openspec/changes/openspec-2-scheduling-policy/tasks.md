## 1. Split the long requirements of `scheduling-policy`

- [x] 1.1 MODIFY "Ordering chain": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.2 MODIFY "Scope filter at admission": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.3 List every moved sentence in the proposal with the requirement that holds it

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-scheduling-policy --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `scheduling-policy --type spec --strict` there
