## Why

`POST /v1/attachments/ended` ended every live attachment whose chain shared any pid with the posted chain. When a session runs inside another one (a worker that runs `codex exec` with the orchestrator Codex plugin installed, or `claude -p` with the Claude Code plugin), the nested session's SessionEnd hook posts a chain that reaches the outer session's processes, so its end ended the outer session's attachment and the daemon took back every launch that session's workers held. Seen 2026-11-17 during the CLOUD-M3 run: about ten nested `codex exec` probes between 21:48 and 22:21 revoked launches of ORC-142 (6), ORC-16 (3) and ORC-18 (2) (ORC-143). The attachment chain also held pid 1, which any long enough chain would match.

## What Changes

- The daemon ends an attachment from `POST /v1/attachments/ended` only when the posted chain's nearest pid that is also in the attachment's chain is the hook's parent or grandparent (`pids[1]` or `pids[2]`). A session nested under a shell or another process further down no longer matches its outer session. The rule is `sessionEndMatches` in `src/runs/ancestry.ts`, used by `Orchestrator.endAttachmentsByPids`.
- pid 1 never matches, and `ancestorPids` stops before adding it.
- The hook scripts under `hosts/` are unchanged, so hooks installed with 0.6.0 get the fix. `POST /v1/attachments/:id/end` and the dead-first-pid reconcile are unchanged.

## Impact

- `src/runs/ancestry.ts` (`ancestorPids`, new `sessionEndMatches`), `src/loop/orchestrator.ts` (`endAttachmentsByPids`).
- Tests: new `test/loop/attachments-nested.test.ts`; a top-of-tree case in `test/runs/ancestry.test.ts`.
- Spec `operator-control`: requirement "Session attachments".
