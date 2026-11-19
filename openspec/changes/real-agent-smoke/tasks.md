## 1. Overlay

- [x] 1.1 `deploy/overlays/kind-claude/kustomization.yaml` and `real-task.yaml`
- [x] 1.2 `test/host/real-agent-overlay.test.ts`

## 2. Smoke script

- [x] 2.1 `--real-agent <key file>` and its key file rule in the argument loop; the usage line
- [x] 2.2 Block A: worker image build and load, the CLI check, the termination step and its two assertions
- [x] 2.3 Block B: the `Orchestrator-Launch` trailer assertion
- [x] 2.4 The real-agent step, last, and its skip lines without the option
- [x] 2.5 `cleanup`: delete a `smoke-term` pod the pass started; scale the workers to 0 after `--real-agent`
- [x] 2.6 `test/host/smoke.test.ts`: dry-run order with the M4 names, `--real-agent` dry run, refusals

## 3. Image

- [x] 3.1 Build the Claude worker image and run the smoke with `--fresh`
- [x] 3.2 Pin `CLAUDE_CODE_VERSION` to the version the pod printed; `test/host/worker-image.test.ts`

## 4. Docs

- [x] 4.1 `deploy/README.md` "Smoke test", "The kind overlay", "Manifests", "Claude worker image"

