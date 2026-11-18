## 1. Daemon

- [x] 1.1 `sessionEndMatches` in `src/runs/ancestry.ts`: the nearest shared pid, never 1, is `pids[1]` or `pids[2]`
- [x] 1.2 `endAttachmentsByPids` ends only the attachments `sessionEndMatches` accepts
- [x] 1.3 `ancestorPids` stops before pid 1

## 2. Tests

- [x] 2.1 `test/loop/attachments-nested.test.ts`: nested chain leaves the attachment live; parent or grandparent ends it with a kept release; T or 1 alone ends nothing
- [x] 2.2 `test/runs/ancestry.test.ts`: a walk to the top of the tree leaves out pid 1

## 3. Spec

- [x] 3.1 Modify `operator-control` "Session attachments"
