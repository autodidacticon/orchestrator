## Why

The import skills offer a Linear project milestone as a root, but the run skills map its `setState` effects to a workflow state and post its comments on an issue. A project has neither. This change gives each host one rule for these effects and one sentence on the root record.

## What Changes

- Run skill of each host: a rule for a Linear effect whose `url` is a project URL.
- Import skill of each host: a sentence on the root record of a project-milestone root.
- No daemon code changes.

## Impact

- Specs: `host-integration` (two ADDED requirements).
