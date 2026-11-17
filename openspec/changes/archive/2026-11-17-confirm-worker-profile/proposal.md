## Why

The daemon prepares a launch as soon as a task is ready. When nothing chose the worker model or effort, the launch runs with the kind's built-in values (`claude-opus-5-5`, `gpt-6-astra` or `anthropic/claude-opus-5-5`, each at `medium`). `status` shows the run default only, not what each task that has not started will run with. A run cannot ask for the profile to be chosen before work starts (ORC-83, task 83a).

## What Changes

- A new configuration key `runner.confirmProfile`, a boolean that is `false` by default. The hold in force is the stored choice (kv `runner.confirmProfile` `on` or `off`) when there is one, else the key. This change only reads the stored choice.
- With the hold on, a task whose model or effort would come from a built-in default (the leaf of its runner kind with source `default`, not the task's payload) is left out of the `ready` list before admission, as the scope filter narrows it. It takes no capacity, defers nothing, stays `unstarted` and gets no launch row and no event. In `spawn` mode a key the kind's command template has no slot for does not hold.
- Confirming is setting: any value from `start`, `configure`, `--set` or `orchestrator.yaml` ends the hold for that key, also when it equals the built-in value.
- Only admission is held. A resume, a parked or live launch and a recovery launch of the same attempt go on; a retry and a launch after a release, unblock or reopen come from admission and are held like a first launch. The hold is not a pause: `paused` and `stalled` stay false.
- `status.profiles` lists every `unstarted` task's profile, grouped, with the source of each key (`task`, `argument`, `file` or `default`), `held`, `missing`, a count and at most five task ids. `status.runner.confirmProfile` is the hold in force. The body of `GET /v1/status` without a graph carries both (`profiles: []`).
- The wait digest carries `profileHeld`: one `{ runner, missing, tasks }` entry per runner kind with a held task.
- No built-in model or effort changes. The override document, `selectionFor`'s return value, the launch row and `launch.created` keep their shape.

## Capabilities

### New Capabilities

### Modified Capabilities
- `model-selection`: ADDED "Profile hold at admission" and "Profile sources of a task".
- `operator-control`: ADDED "Profile hold key" and "Status report: profiles".
- `operator-mcp`: ADDED "Wait digest: profileHeld".
