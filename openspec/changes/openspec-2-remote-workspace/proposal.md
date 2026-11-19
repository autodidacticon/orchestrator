## Why

OpenSpec 2.1 flags a requirement whose description (the text between its `### Requirement:` line and its first scenario) is longer than 500 characters, and `openspec validate --strict` fails on it. Two of the 5 requirements of `remote-workspace` are over the limit: "Remote workspace" (577 characters) and "Seal" (1636 characters). This change splits each of them the way OpenSpec 2.1 prescribes, without changing what the spec requires. It is part of the OpenSpec 2.1 migration (ORC-139, task ORC-148).

## What Changes

- MODIFIED, two requirements: "Remote workspace" and "Seal". Each keeps its header and every scenario, names and texts unchanged; its description is cut to one behavior of at most 500 characters.
- ADDED, eight requirements, one per behavior removed from a MODIFIED description. Each holds the moved sentences, unchanged or with only their references made explicit, and one new scenario.
- No sentence of the originals is over 500 characters on its own, so none is split.
- No SHALL or MUST is dropped: the two original descriptions hold 21, and the cut and ADDED descriptions hold 21. Nothing is removed or renamed, and no other requirement changes.

### Moved sentences

Each sentence moved out of a MODIFIED description, and the ADDED requirement that now holds it. Every other sentence stays in its MODIFIED description.

### Remote workspace

- "`integrationHead` and `tagMilestone` SHALL reject: the integration branch belongs to the daemon's own workspace" → "Remote workspace integration calls" (reference made explicit: "of `RemoteWorkspace`")

### Seal

- "When origin has no such branch, the submit SHALL answer 409 `{ reason: 'branchNotPushed', branch }`; the answer SHALL come from origin, never from a ref an earlier fetch left in the clone" → "Seal answers when origin lacks the sealed tip" (references made explicit: "no launch branch", "the remote submit")
- "When origin's tip differs, the submit SHALL answer 409 `{ reason: 'shaMismatch', branch, expected, actual }` with `expected` the reported `sealedSha` and `actual` origin's tip" → "Seal answers when origin lacks the sealed tip" (references made explicit: "origin's tip of the launch branch differs from the reported `sealedSha`", "the remote submit")
- "When origin cannot be fetched (unreachable, timed out, or no remote configured), the submit SHALL answer 503 `{ reason: 'originUnreachable' }`; when origin refuses the credentials or access, 503 `{ reason: 'originRefused' }`" → "Seal answers when origin cannot be fetched" (reference made explicit: "the remote submit")
- "On any of these the task SHALL stay `running` and nothing SHALL be recorded, so the worker may retry" → "Seal refusal leaves the task running" ("any of these" made explicit as "any `branchNotPushed`, `shaMismatch`, `originUnreachable` or `originRefused` answer to a remote submit")
- "When the tips match, the fetched tip SHALL be the `sealedSha`, and the submission checks (`emptySubmission`, acceptance evidence) SHALL run against it and the launch's `baseSha` as for a local submit" → "Seal checks on a matching tip" (references made explicit: "the tips of a remote seal", "against the fetched tip")
- "The fetched commit SHALL stay in the clone, where the verifier rebases it" → "Sealed commit stays in the clone" (reference made explicit: "of a remote seal")
- "No commit is made and the commit policy does not apply" → "Sealed commit stays in the clone" (reference made explicit: "by the remote seal")
- "A seal called without a reported `sealedSha`, or on a daemon without an origin, SHALL reject as the tree-bound calls of "Remote workspace" do" → "Remote seal preconditions"
- "The fallback report file SHALL NOT be read for a remote launch, and the launch branch on origin SHALL NOT be deleted after publication" → "Remote launch keeps its fallback file and origin branch untouched"

### Where each new scenario comes from

At the base commit e0f3aa6:

- "Accepted report carries the sealed tip": `test/slice/remote-seal.test.ts` ("refuses a branch not on origin and another tip, ...": the accepted response has `sealedSha` the tip, and the one report's payload is `{ kind: 'submit', seq: 1, sealedSha: tip }`).
- "Integration calls refused by the remote workspace": `src/workspace/remote-workspace.ts` (`integrationHead`, `tagMilestone` throw), `test/slice/remote-access.test.ts` ("workspaceByAccess routes launch calls by access and keeps the integration side local").
- "Not-pushed answer comes from origin": `src/workspace/origin.ts` (`fetchBranch` returns undefined on "couldn't find remote ref"), `src/workspace/remote-workspace.ts` (`seal` maps undefined to `branchNotPushed`).
- "Refused fetch and missing remote": `test/slice/remote-seal.test.ts` ("maps a refused fetch to originRefused and a missing remote to originUnreachable, both answered 503").
- "Retry after a refused seal": `test/slice/remote-seal.test.ts` ("origin unreachable answers 503 originUnreachable, records nothing, and the task stays running until origin is back").
- "Sealed commit rebased from the clone": `test/slice/remote-seal.test.ts` ("refuses a branch not on origin and another tip, ...": clone ref equals the tip and `job.sealedSha` is the tip).
- "Seal without a sealed sha or an origin": `test/slice/remote-seal.test.ts` ("without a sealedSha or an origin it rejects as a tree-bound call").
- "Fallback read refused for a remote launch": `src/workspace/remote-workspace.ts` (`workspaceByAccess` routes `readFallback` by access; `RemoteWorkspace.readFallback` throws `noWorktreeError`), `test/slice/remote-access.test.ts` ("seal, preserve and readFallback reject naming the remote launch").

## Capabilities

### New Capabilities

### Modified Capabilities

- `remote-workspace`: "Remote workspace" and "Seal" have their descriptions cut to one behavior each; the moved behaviors become eight ADDED requirements. What the spec requires is unchanged.

## Impact

Only `openspec/changes/openspec-2-remote-workspace/`. No code changes.
