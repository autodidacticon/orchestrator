import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED_TOOLS_SLOT, DEFAULT_CLAUDE_COMMAND, hasAllowedToolsSlot, hasEffortSlot, hasModelSlot, quoteRules } from '../../src/runner/command.js';
import { SubprocessRunner, substitute } from '../../src/runner/subprocess.js';
import type { Launch } from '../../src/state/store.js';
import { detectToolchain } from '../../src/toolchain/detect.js';
import { BASE_RULES, rulesFor } from '../../src/toolchain/tools.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/toolchains');
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
  return readFileSync(file, 'utf8').trim();
}

// See specs/toolchain-discovery "Runner command composition".
describe('runner command composition', () => {
  it('fills the default template with the Node list in order, each rule double-quoted', async () => {
    const rules = [...BASE_RULES, ...rulesFor(await detectToolchain(path.join(fixtures, 'node-npm')))];
    const cmd = substitute(DEFAULT_CLAUDE_COMMAND, { mcpConfig: '/m.json', brief: '/b.md', allowedTools: quoteRules(rules), model: 'claude-opus-5-5', effort: 'medium' });
    expect(cmd).toBe(
      'claude -p --output-format json --mcp-config /m.json --strict-mcp-config --permission-mode acceptEdits --allowedTools "Bash(git:*)" "mcp__orchestrator__heartbeat" "mcp__orchestrator__report" "mcp__orchestrator__block" "mcp__orchestrator__inbox" "mcp__orchestrator__log" "Bash(npm test:*)" "Bash(npm run:*)" "Bash(npm install:*)" "Bash(npm exec:*)" "Bash(node:*)" "Bash(npm ci:*)" "Bash(npx:*)" --model claude-opus-5-5 --effort medium --no-session-persistence < /b.md',
    );
    expect(cmd).not.toContain(ALLOWED_TOOLS_SLOT);
    expect(cmd).not.toMatch(/\{model\}|\{effort\}/);
  });

  it('quotes rules and recognises the slot', () => {
    expect(quoteRules(['a', 'b c'])).toBe('"a" "b c"');
    expect(quoteRules([])).toBe('');
    expect(hasAllowedToolsSlot(DEFAULT_CLAUDE_COMMAND)).toBe(true);
    expect(hasAllowedToolsSlot('claude -p --allowedTools "Bash(git:*)" < {brief}')).toBe(false);
    // See specs/model-selection "Runners and workers receive the values".
    expect(hasModelSlot(DEFAULT_CLAUDE_COMMAND)).toBe(true);
    expect(hasEffortSlot(DEFAULT_CLAUDE_COMMAND)).toBe(true);
    expect(hasModelSlot('claude -p {allowedTools} < {brief}')).toBe(false);
  });

  it('the subprocess runner fills the slot from its getter at spawn and runs a slot-less command verbatim', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-compose-'));
    dirs.push(dir);
    const worktree = path.join(dir, 'wt');
    mkdirSync(path.join(worktree, '.orchestrator'), { recursive: true });
    const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'launching', token: 't', branch: 'task/T1/l1', worktree, baseSha: 'b', graphRev: 'r', createdAt: 1 } as unknown as Launch;
    let rules = ['Bash(git:*)', 'Bash(npm test:*)'];
    const withSlot = new SubprocessRunner({ command: () => 'echo {allowedTools} > {worktree}/.orchestrator/tools.txt', allowedTools: () => rules, logDir: path.join(dir, 'logs') });
    await withSlot.spawn(launch, {});
    expect(await waitForFile(path.join(worktree, '.orchestrator', 'tools.txt'))).toBe('Bash(git:*) Bash(npm test:*)');
    rules = ['Bash(docker:*)'];
    const again = { ...launch, launchId: 'L2', worktree: path.join(dir, 'wt2') } as Launch;
    mkdirSync(path.join(again.worktree, '.orchestrator'), { recursive: true });
    await withSlot.spawn(again, {});
    expect(await waitForFile(path.join(again.worktree, '.orchestrator', 'tools.txt'))).toBe('Bash(docker:*)');
    const verbatim = new SubprocessRunner({ command: 'echo verbatim "{launchId}" > {worktree}/.orchestrator/out.txt', allowedTools: () => rules, logDir: path.join(dir, 'logs') });
    const third = { ...launch, launchId: 'L3', worktree: path.join(dir, 'wt3') } as Launch;
    mkdirSync(path.join(third.worktree, '.orchestrator'), { recursive: true });
    await verbatim.spawn(third, {});
    expect(await waitForFile(path.join(third.worktree, '.orchestrator', 'out.txt'))).toBe('verbatim L3');
  });
});
