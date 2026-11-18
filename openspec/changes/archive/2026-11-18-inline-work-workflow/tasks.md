## 1. Skills

- [x] 1.1 `run` skill: start the workflow by reading `<plugin dir>/workflows/work.js` and passing its text as `script`; `scriptPath` only after `/add-dir`; re-run may use the saved path
- [x] 1.2 `work` skill: the same

## 2. Tests

- [x] 2.1 `test/host/work-loop.test.ts`: word pins for the inline instruction in both skills, and `workflows/work.js` exists in the plugin directory the package ships

## 3. Spec

- [x] 3.1 Modify `host-integration` "Work skill and workflow"
