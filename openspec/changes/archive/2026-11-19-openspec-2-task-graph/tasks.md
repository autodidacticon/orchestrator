## 1. Split the long requirements of `task-graph`

- [x] 1.1 MODIFY "Reload compatibility": keep header and scenarios, cut the description; add seven requirements from the moved text
- [x] 1.2 MODIFY "Revocability through milestones": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.3 List every moved sentence in the proposal with the requirement that holds it

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-task-graph --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `task-graph --type spec --strict` there
