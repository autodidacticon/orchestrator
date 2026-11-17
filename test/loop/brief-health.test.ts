import { describe, expect, it } from 'vitest';
import { composeBrief } from '../../src/brief/compose.js';
import type { Launch } from '../../src/state/store.js';
import type { BriefInput, BriefRunner } from '../../src/workspace/workspace.js';

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

// See specs/agent-protocol "Brief states the limits in force".
describe('brief: limits line', () => {
  const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree: '/w', baseSha: 'base', graphRev: 'r', createdAt: 1 } as Launch;
  const input: BriefInput = { launch, node: { id: 'T1', kind: 'task', payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: [] }, depReports: [], apiBaseUrl: 'http://127.0.0.1:1', retryWindowMs: 1000, checkCommand: 'true', integrationBranch: 'main' };
  const limits = { stuckAfterMs: 900000, stuckFailAfterMs: 2700000, maxLaunchMs: 7200000 };
  const keys = { stuckAfterMs: 'health.stuckAfterMs', stuckFailAfterMs: 'health.stuckFailAfterMs', maxLaunchMs: 'budgets.maxLaunchMs' } as const;
  const compose = (i: BriefInput) => composeBrief(i, { fallbackPath: '/x', openspec: false });
  const reporting = (md: string) => md.split('## Reporting\n')[1]!.split('\n## ')[0]!;
  const limitsLines = (md: string) => md.split('\n').filter((l) => l.startsWith('- Limits:'));

  it('states the three limits in force, their consequences, the progress signals, and how a change arrives', () => {
    const { markdown, json } = compose({ ...input, limits });
    const lines = reporting(markdown).split('\n').filter((l) => l.startsWith('- Limits:'));
    expect(lines).toHaveLength(1);
    expect(limitsLines(markdown)).toHaveLength(1);
    const line = lines[0]!;
    for (const needle of [
      '`health.stuckAfterMs` 900000',
      '`health.stuckFailAfterMs` 2700000',
      '`budgets.maxLaunchMs` 7200000',
      '900s',
      '2700s',
      '7200s',
      'a `stuck` notice arrives in your inbox',
      'your launch is ended and the attempt is spent',
      'a call to an operation, a new commit, or a change in the worktree',
      'even while it makes progress',
      'Call `heartbeat` between long steps',
      'run a longer command in the background',
      'report what you have, or ask a question',
      'in force when this brief was written',
      'the operator can change them during the run',
      'a change arrives as a `nudge` notice in your inbox',
    ]) {
      expect(line, needle).toContain(needle);
    }
    // Every limit is a length of time only; no URL.
    expect(line).not.toContain('http');
    expect(line).not.toContain('127.0.0.1');
    expect(json.limits).toEqual(limits);
  });

  for (const zero of Object.keys(keys) as Array<keyof typeof keys>) {
    it(`drops the part of ${zero} when it is 0 and keeps the other two`, () => {
      const { markdown, json } = compose({ ...input, limits: { ...limits, [zero]: 0 } });
      const lines = limitsLines(markdown);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(keys[zero]);
      for (const other of Object.keys(keys) as Array<keyof typeof keys>) if (other !== zero) expect(lines[0]).toContain(`\`${keys[other]}\` ${limits[other]}`);
      expect(json.limits).toEqual({ ...limits, [zero]: 0 });
    });
  }

  it('promises no `stuck` notice when only the fail limit is set', () => {
    const line = limitsLines(compose({ ...input, limits: { stuckAfterMs: 0, stuckFailAfterMs: 2700000, maxLaunchMs: 0 } }).markdown)[0]!;
    expect(line).not.toContain('`stuck`');
    expect(line).toContain('your launch is ended and the attempt is spent');
    expect(line).not.toContain('budget');
  });

  it('states the budget and what counts as progress when only the budget is set', () => {
    const line = limitsLines(compose({ ...input, limits: { stuckAfterMs: 0, stuckFailAfterMs: 0, maxLaunchMs: 7200000 } }).markdown)[0]!;
    expect(line).toContain('`budgets.maxLaunchMs` 7200000');
    expect(line).toContain('a call to an operation, a new commit, or a change in the worktree');
    expect(line).toContain('Your launch is ended, and the attempt spent');
    expect(line).not.toContain('health.');
    expect(line).not.toContain('`stuck`');
  });

  it('has no line with all three 0, while brief.json keeps the zeros', () => {
    const { markdown, json } = compose({ ...input, limits: { stuckAfterMs: 0, stuckFailAfterMs: 0, maxLaunchMs: 0 } });
    expect(limitsLines(markdown)).toEqual([]);
    expect(json.limits).toEqual({ stuckAfterMs: 0, stuckFailAfterMs: 0, maxLaunchMs: 0 });
  });

  it('has no line and no brief.json key for an input without limits', () => {
    const { markdown, json } = compose(input);
    expect(limitsLines(markdown)).toEqual([]);
    expect(markdown).not.toContain('budgets.maxLaunchMs');
    expect('limits' in json).toBe(false);
  });

  const runners: BriefRunner[] = [
    { kind: 'claude-code', commitPolicy: 'agent' },
    { kind: 'claude-code', commitPolicy: 'daemon' },
    { kind: 'codex', commitPolicy: 'agent', sandbox: 'danger-full-access' },
    { kind: 'codex', commitPolicy: 'daemon', sandbox: 'workspace-write' },
    { kind: 'opencode', commitPolicy: 'agent' },
    { kind: 'opencode', commitPolicy: 'daemon' },
  ];
  for (const runner of runners) {
    for (const leaseTtlMs of [undefined, 60_000]) {
      it(`is present for ${runner.kind} under ${runner.commitPolicy} commits ${leaseTtlMs ? 'with' : 'without'} a lease, after the lease line`, () => {
        const { markdown } = compose({ ...input, runner, limits, ...(leaseTtlMs ? { leaseTtlMs } : {}) });
        const lines = reporting(markdown).split('\n');
        const at = lines.findIndex((l) => l.startsWith('- Limits:'));
        expect(at).toBeGreaterThan(-1);
        expect(lines.filter((l) => l.startsWith('- Limits:'))).toHaveLength(1);
        const lease = lines.findIndex((l) => l.startsWith('- Lease:'));
        if (leaseTtlMs) expect(lease).toBe(at - 1);
        else expect(lease).toBe(-1);
      });
    }
  }
});
