import { describe, expect, it } from 'vitest';
import { composeBrief } from '../../src/brief/compose.js';
import type { Launch } from '../../src/state/store.js';

describe('brief: health wording', () => {
  it('names the inbox notices and allows rebasing the launch branch onto the integration head', () => {
    const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree: '/w', baseSha: 'base', graphRev: 'r', createdAt: 1 } as Launch;
    const { markdown } = composeBrief(
      { launch, node: { id: 'T1', kind: 'task', payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: [] }, depReports: [], apiBaseUrl: 'http://127.0.0.1:1', retryWindowMs: 1000, checkCommand: 'true', integrationBranch: 'main' },
      { fallbackPath: '/w/.orchestrator/report.json' },
    );
    for (const needle of ['`stuck`', '`nudge`', '`baseMoved`', '`payloadChanged`', 'Check the inbox after long steps', 'You may rebase your launch branch onto it', 'Never merge into, push to, or check out `main`']) {
      expect(markdown, needle).toContain(needle);
    }
    expect(markdown).not.toContain('Never merge, rebase onto, or touch');
  });

  it('keeps the rebase allowance under the agent commit policy and drops it under daemon', () => {
    const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree: '/w', baseSha: 'base', graphRev: 'r', createdAt: 1 } as Launch;
    const input = { launch, node: { id: 'T1', kind: 'task', payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: [] }, depReports: [], apiBaseUrl: 'http://127.0.0.1:1', retryWindowMs: 1000, checkCommand: 'true', integrationBranch: 'main' };
    const agent = composeBrief({ ...input, runner: { kind: 'codex', commitPolicy: 'agent', sandbox: 'danger-full-access' } }, { fallbackPath: '/x' }).markdown;
    expect(agent).toContain('You may rebase your launch branch onto it');
    const daemon = composeBrief({ ...input, runner: { kind: 'codex', commitPolicy: 'daemon', sandbox: 'workspace-write' } }, { fallbackPath: '/x' }).markdown;
    expect(daemon).not.toContain('You may rebase');
    expect(daemon).toContain('`baseMoved`');
    expect(daemon).toContain('Never merge into, push to, or check out `main`');
  });
});
