## 1. Split the long requirements of `model-selection`

- [x] 1.1 MODIFY "Run default model and effort": keep header and scenarios, cut the description; add four requirements from the moved text
- [x] 1.2 MODIFY "Task selectors": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.3 MODIFY "Resolution fixed at preparation": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.4 MODIFY "Profile hold at admission": keep header and scenarios, cut the description; add five requirements from the moved text
- [x] 1.5 MODIFY "Profile sources of a task": keep header and scenarios, cut the description; add two requirements from the moved text
- [x] 1.6 List every moved sentence in the proposal with the requirement that holds it

## 2. Checks

- [x] 2.1 `openspec validate openspec-2-model-selection --strict`
- [x] 2.2 Compare the scenarios of each MODIFIED requirement with the base spec; count SHALL and MUST before and after
- [x] 2.3 Archive into a copy of `openspec/` and validate `model-selection --type spec --strict` there
