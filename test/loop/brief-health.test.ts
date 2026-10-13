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
});
