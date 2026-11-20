## MODIFIED Requirements

### Requirement: Work workflow: worker tool instructions
On a claim the loop SHALL run a worker agent whose prompt is composed from tool instructions plus the path of the brief file: work in the worktree with ordinary tools, commit on the launch branch, ask questions through `launch_block` and call it again while pending, report through `launch_report`, commit and resubmit with the same seq on a 409 dirty-worktree rejection, never write the fallback file, and stop on 401. The prompt SHALL NOT hold the brief's text.

#### Scenario: Prompt rules
- **WHEN** the worker prompt of `workflows/work.js` is composed for a claim
- **THEN** it says to commit on the launch branch, to call `launch_block` again with the same seq while pending, to commit and call again with the same seq on a 409 `dirtyWorktree`, never to write a fallback report file, and to stop on 401, and it names the brief file's path

## ADDED Requirements

### Requirement: Work workflow: worker tool instructions: brief path fallback
When the claim answer has no `briefPath`, the worker prompt SHALL name `<worktree>/.orchestrator/brief.md`, built from the claim's `worktree`, as the brief file, and SHALL NOT name `undefined`.

#### Scenario: Claim answer without briefPath
- **WHEN** a claimer answers a launch for T1 with worktree `/runs/r1/worktrees/L9` and no `briefPath`
- **THEN** the worker prompt says the brief is the file `/runs/r1/worktrees/L9/.orchestrator/brief.md` and does not contain `undefined`
