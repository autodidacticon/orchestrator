## 1. Split the long requirements

- [x] 1.1 Cut the descriptions of the 13 requirements to one behavior of at most 500 characters each, keeping every header and scenario
- [x] 1.2 Add each removed behavior as a requirement of its own with a new scenario backed by the code at the base
- [x] 1.3 List every moved sentence and its new requirement in the proposal

## 2. Checks

- [x] 2.1 Compare the scenarios of each MODIFIED requirement with the base spec
- [x] 2.2 Count SHALL and MUST before and after
- [x] 2.3 `openspec validate openspec-2-host-integration-1 --strict`
- [x] 2.4 Archive in a copy of `openspec/` and validate `host-integration` there with `--strict`
