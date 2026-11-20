## Why

GH-182 moved the Claude Code work workflow's stop decision into `stopRule` in `hosts/claude-code/workflows/work.js`. The owner has since decided that the rule exists once, in the daemon: GH-192 serves a work verdict per runner kind as `workByKind` in the `wait` digest. A second rule in the script can disagree with the daemon, and a claimer that answers `{ claimed: false }` with no digest fields kept its loop polling up to the 200-cycle cap (GH-196).

## What Changes

- `hosts/claude-code/workflows/work.js`: `stopRule` and the `held` map are removed. The claimer copies `workByKind["claude-code"]` (`verdict`, `claimable`, `preparing`, `working`) with `openQuestions` and `awaitingReview` from its last `wait` digest, and returns before its third poll only when the verdict is `finished`, `stalled` or `human`. The loop ends on those three verdicts and runs another claimer on any other (`paused` included). A claimer answer without a verdict ends the loop with `<workerId>: the wait digest holds no work verdict (an older daemon), loop ends`. `CLAIM_SCHEMA` gains `verdict` and `working` and loses `finished`, `stalled` and `verifying`. The workflow result's `digest` is `{ verdict, finished, stalled, claimable, preparing, working, openQuestions, awaitingReview }`, with `finished` and `stalled` derived from the verdict.
- `hosts/claude-code/skills/run/SKILL.md` section 1a and `hosts/claude-code/skills/work/SKILL.md` section 2 say a loop ends when the verdict for `claude-code` is `finished`, `stalled` or `human`; neither names `preparingByKind`.

Unchanged: the brief by path, no `status` call, one retry for a silent claimer, `brief: false`, three polls of 90 s, the 200-cycle cap.

Specs (host-integration):

- MODIFIED "Work skill and workflow" (all 11 scenarios restated; four with new text), "Work workflow: claims only claude-code launches", "Work workflow: loop end", "Work workflow: claimer agent: digest fields".
- REMOVED "Work workflow: claimer agent: stop rule in the script".
- ADDED "Work workflow: loop end: digest without a verdict".

## Impact

- `hosts/claude-code/workflows/work.js`, `hosts/claude-code/skills/run/SKILL.md`, `hosts/claude-code/skills/work/SKILL.md`
- `test/host/work-loop.test.ts`, `test/host/package.test.ts`
