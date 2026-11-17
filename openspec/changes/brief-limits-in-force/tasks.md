## 1. Brief input and composition

- [x] 1.1 Add `limits?: BriefLimits` to `BriefInput` (`src/workspace/workspace.ts`)
- [x] 1.2 Add `limits?` to `BriefJson`, copied only when the input has it; add `limitsRule` and push its line after the lease line in the Reporting section (`src/brief/compose.ts`)
- [x] 1.3 Fill `limits` in `briefInput` from `this.effective().config` for every access and runner kind (`src/loop/orchestrator.ts`)

## 2. Tests

- [x] 2.1 Unit tests on `composeBrief` in `test/loop/brief-health.test.ts`: the full line, each limit 0 in turn, all 0, no `limits`, every runner kind and commit policy with and without a lease
- [x] 2.2 `briefInput` carries the configured limits in `spawn` and `pull` mode (`test/loop/brief.test.ts`)
- [x] 2.3 Golden briefs under `test/fixtures/brief/` unchanged
