## 1. Implementation

- [x] 1.1 Read the whole log line by line (streamed, so memory stays bounded), summing every `step_finish`; skip a line longer than a cap without parsing its body
- [x] 1.2 Tests: the reviewer's three-line log (a step, a 300 KiB tool line, a step) sums both steps; a 5 MiB log with 200 steps sums exactly, from a string and streamed from the file; F1-ask and SA-proj2 expectations unchanged

## 2. Spec

- [x] 2.1 worker-runners "OpenCode usage parsing" says the whole log is read and why
