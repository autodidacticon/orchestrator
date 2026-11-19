## Why

The cloud-native M4 claim is that a Claude worker works a task in the cluster: the task reaches done with a launch cost above zero, the integration commit carries an `Orchestrator-Launch` trailer, and deleting the worker pod mid-task hands the launch back with `kept: true` (ORC-31). The machine the tasks run on has no Anthropic key and the cluster has no such Secret, so the claim is split: what needs no model runs in every smoke, and what needs one runs only when the owner passes a key file.

## What Changes

- `deploy/smoke.sh` gains the M4 step. Block A, between the final drill claim and the M3 scale-up: it builds the Claude worker image (`WORKER_IMAGE`, default `orchestrator-worker-claude:dev`, `PROJECT_BASE=$IMAGE`), loads it into kind, and checks that the image runs `claude --version`. Then it works `SMOKE-M3-A` with a one-shot pod `smoke-term` whose stand-in agent prints a Claude result object and sleeps, deletes the pod mid-task with a 120 s grace, and asserts the kept release and the recorded usage. Block B, after the M3 assertions, checks that every integration commit's `Orchestrator-Launch` trailer names a reported launch.
- `deploy/smoke.sh` accepts `--real-agent <key file>`. The real-agent step, last, creates the Secret `anthropic-api-key`, swaps the worker pool for Claude workers (`deploy/overlays/kind-claude`), adds `SMOKE-REAL` to the graph and asserts it done, its cost above zero and its trailer. Without the option its three assertions print `smoke: skip: <name> (needs --real-agent)`. This change writes that step and tests its dry run; it does not run it.
- New `deploy/overlays/kind-claude`: the kind overlay with `orchestrator-worker` on the Claude worker image, the command agent and the key from the Secret; `real-task.yaml` is the `SMOKE-REAL` graph fragment.
- `deploy/worker-claude/Dockerfile` pins `CLAUDE_CODE_VERSION` to `2.1.328`, the version the smoke's pod printed. The build needed no other fix.
- `deploy/README.md` "Smoke test", "The kind overlay", "Manifests" and "Claude worker image".

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cluster-runtime`: ADDED "Smoke M4 step", "Smoke real-agent step", "Kind overlay for the Claude worker"; MODIFIED "Smoke test", "Smoke test options", "Smoke assertions are named".

## Impact

- `deploy/smoke.sh`, new `deploy/overlays/kind-claude/`, `deploy/worker-claude/Dockerfile`, `deploy/README.md`.
- Tests: `test/host/smoke.test.ts`, new `test/host/real-agent-overlay.test.ts`, `test/host/worker-image.test.ts`.
- `src/`, `deploy/base/`, `deploy/overlays/kind/` and the root `Dockerfile` are not changed.
- Not proven here: that a real `claude` in the pod reads the key, follows the brief and reports. The owner runs `bash deploy/smoke.sh --fresh --real-agent <key file>` for that.
