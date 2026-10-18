## Why

Exercising the GitHub tracker on a throwaway repository showed two gaps. A cancelled child of an epic is imported as an external node with `done: false`, so the parent milestone can never complete and any task blocked by it never becomes ready; this is the mapping rule for every tracker, not a GitHub detail. And the run skill's GitHub branch closes an issue as done or cancelled but leaves the in-progress label on it, so a closed issue still reads as in progress.

## What Changes

- A cancelled child maps to an external node with `done: true` (nothing waits on work that will never happen); `trackerState: cancelled` stays on the payload so the review still shows it was cancelled rather than finished.
- The run skill removes the policy's in-progress label when it closes a GitHub issue as completed or not planned.
- The `import_issues` tool description and the import skill say the same.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `graph-import`: `Mapping rules` gives cancelled children `done: true` with two scenarios.
- `host-integration`: `Run skill mirrors to the tracker` removes the in-progress label on close.

## Impact

- Code: `src/import/mapping.ts` (one expression), `src/operator/mcp-server.ts` (description), `hosts/claude-code/skills/run/SKILL.md`, `hosts/claude-code/skills/import/SKILL.md`, `test/import/mapping.test.ts`, `test/host/package.test.ts`.
- Behaviour: a run imported from an epic with cancelled children now finishes; previously it stalled at the milestone. Linear and Jira imports are affected the same way, which is the point.
