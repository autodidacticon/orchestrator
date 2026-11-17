## Why

After `review-index-answer` the default `review` answer is an index without acceptance evidence, but the three review skills still say the answer holds everything. This change rewrites them against the answer's `view` field.

## What Changes

- Review skill of each host: read the index, then each task with `task`; rules for an answer with no `view`, an operator server without `task`, a refused answer, and a `previous` block; a sha and version check before deciding.
- Claude Code edition: each fanned-out reviewer fetches its own task.
- No daemon code changes.

## Impact

- Specs: `host-integration` (one ADDED requirement).
