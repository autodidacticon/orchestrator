## 1. Split the long requirements of `state-backend`

- [x] 1.1 MODIFY "Durability before effects": keep header and scenarios, cut the description; add one requirement from the moved text
- [x] 1.2 MODIFY "Postgres migrations": keep header and scenarios, cut the description; add four requirements from the moved text
- [x] 1.3 MODIFY "Postgres schema": keep header and scenarios, cut the description; add one requirement from the moved text
- [x] 1.4 MODIFY "Postgres test database": keep header and scenarios, cut the description; add four requirements from the moved text
- [x] 1.5 MODIFY "Store selection": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.6 MODIFY "Run id per deployment": keep header and scenarios, cut the description; add one requirement from the moved text
- [x] 1.7 MODIFY "No store URL in child environments": keep header and scenarios, cut the description, split the 516-character sentence between its list items; add five requirements from the moved text
- [x] 1.8 MODIFY "Shutdown with unflushed batches": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.9 MODIFY "Store credentials a child can still reach": keep header and scenarios, cut the description; add one requirement from the moved text
- [x] 1.10 List every moved sentence in the proposal with the requirement that holds it

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-state-backend --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `state-backend --type spec --strict` there
