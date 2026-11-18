## Why

A remote launch has no worktree on the daemon's host (ORC-11), so its submit cannot be sealed by inspecting a tree: `RemoteWorkspace.seal` rejected. The worker pushes the launch branch to origin instead, and the daemon needs a way to pin the submission to the commit the worker meant (ORC-18, cloud-native M3).

## What Changes

- The submit report gains `sealedSha`, required on a remote launch: the full object name of the launch branch tip the worker pushed. Missing or malformed, the submit answers 400 with `field: 'sealedSha'`. On a local launch `sealedSha` is ignored, as before.
- `RemoteWorkspace.seal` fetches origin's `refs/heads/<branch>` into the daemon clone's `refs/heads/<branch>` (forced) through the shared `Origin` (new `Origin.fetchBranch`, on the serial chain) and compares the tip with `sealedSha`:
  - no branch on origin: 409 `{ reason: 'branchNotPushed', branch }`;
  - another tip: 409 `{ reason: 'shaMismatch', branch, expected, actual }`;
  - origin unreachable (or its remote not configured): 503 `{ reason: 'originUnreachable' }`; origin refused the credentials: 503 `{ reason: 'originRefused' }`.
  A refused seal records nothing (no event, no dedup entry), so the worker may send the same `seq` again, and the task stays `running`.
- After a successful seal the existing submission checks (`emptySubmission`, acceptance evidence) run unchanged against `sealedSha` and `baseSha`. The fetched commit stays in the clone, so the verifier's rebase needs no change.
- The operator MCP server's `launch_report` tool declares `sealedSha` in its input schema, so the field reaches the daemon (an undeclared field would be stripped), and its description states the remote rule.
- The fallback report path is not used for remote launches. Task branches on origin are not deleted after publication.

## Capabilities

### New Capabilities

None. `remote-workspace` is introduced by the unarchived change `remote-access-mode`; this change adds a requirement to it.

### Modified Capabilities

- `agent-protocol`: "Submission sealing" covers the remote seal and the `sealedSha` field.
- `remote-workspace`: new requirement "Seal".

## Impact

- `src/workspace/origin.ts` (`fetchBranch`), `src/workspace/remote-workspace.ts` (`RemoteWorkspace` takes the daemon's `Origin`; `seal`), `src/workspace/workspace.ts` (`SealOptions.sealedSha`, `RemoteSealRefusal` in `SealResult`), `src/agent/seal.ts` (`remoteSealedSha`), `src/loop/orchestrator.ts` (`handleReport`, `sealSubmission`, `sealRefusal`, the remote workspace built with the origin), `src/launch/prepare.ts` (narrows the widened `SealResult`), `src/operator/mcp-server.ts` (`launch_report` takes `sealedSha`).
- No fetch, push or ls-remote helper is added to `src/workspace/git.ts`.
- Tests: `test/slice/remote-seal.test.ts`.
