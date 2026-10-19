import { afterEach, describe, expect, it } from 'vitest';
import { StaticRemediator } from '../../src/brief/remediate.js';
import { SlotValidator, slotValue } from '../../src/brief/template.js';
import { composeBrief } from '../../src/brief/compose.js';
import { parseGraph } from '../../src/graph/load.js';
import { makeHarness, type Harness } from './harness.js';
import { Orchestrator } from '../../src/loop/orchestrator.js';
import { BASE_RULES } from '../../src/toolchain/tools.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/brief');

const graph = `nodes:
  - { id: A, deps: [], description: "do A" }
  - { id: B, deps: [], description: "do B", acceptanceCriteria: [works] }
  - { id: M, kind: milestone, deps: [A, B] }`;

let h: Harness | undefined;
afterEach(() => h?.cleanup());

function withValidator(opts: Parameters<typeof makeHarness>[0], remediator?: StaticRemediator) {
  const base = makeHarness(opts);
  const orch = new Orchestrator({
    store: base.store,
    config: base.orch.config,
    graphSource: base.source,
    runner: base.runner,
    workspace: base.workspace,
    verifier: base.verifier,
    briefValidator: new SlotValidator(),
    remediator,
    clock: () => base.now.value,
  });
  base.orch = orch;
  return base;
}

describe('revision section', () => {
  const launch = { launchId: 'L2', taskId: 'T2', attempt: 1, launchNo: 2, status: 'live', token: 't', branch: 'task/T2/l2', worktree: '/w', baseSha: 'base2', graphRev: 'r', createdAt: 1 } as const;
  const input = (revision: Record<string, unknown>) => ({
    launch: launch as unknown as Parameters<typeof composeBrief>[0]['launch'],
    node: { id: 'T2', kind: 'task', payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: ['T1'] },
    depReports: [],
    carry: { revision },
    apiBaseUrl: 'http://127.0.0.1:1',
    retryWindowMs: 1000,
    checkCommand: 'true',
    integrationBranch: 'main',
  });

  it('names the published prior commit, the upstream cause, and tells the agent to revise', () => {
    const { markdown, json } = composeBrief(input({ cause: 'upstreamReopened', upstream: 'T1', priorLaunchId: 'L1', priorBranch: 'task/T2/l1', priorPublishedSha: 'P1', priorReportSummary: 'did T2' }), { fallbackPath: '/x' });
    expect(markdown).toContain('## Revision');
    expect(markdown).toContain('upstream task `T1` was reopened');
    expect(markdown).toContain('published commit `P1`, which remains on `main` and is contained in your base commit `base2`');
    expect(markdown).toContain('Prior report: did T2');
    expect(markdown).toContain('Revise the prior work rather than redoing it');
    expect(json.context).toMatchObject({ revision: { cause: 'upstreamReopened', upstream: 'T1', priorPublishedSha: 'P1' } });
  });

  it('a killed prior launch is briefed with its branch and no sha', () => {
    const { markdown } = composeBrief(input({ cause: 'upstreamReopened', upstream: 'T1', priorLaunchId: 'L1', priorBranch: 'task/T2/l1' }), { fallbackPath: '/x' });
    expect(markdown).toContain('worked on branch `task/T2/l1` and did not publish');
    expect(markdown).not.toContain('published commit');
    const reopened = composeBrief(input({ cause: 'reopened', priorLaunchId: 'L1', priorBranch: 'task/T2/l1', priorPublishedSha: 'P1' }), { fallbackPath: '/x' }).markdown;
    expect(reopened).toContain('This task was reopened for revision.');
  });
});

describe('interrupted context', () => {
  it('names the branch, head, and WIP commit and tells the agent to continue or start over', () => {
    const launch = { launchId: 'L2', taskId: 'T2', attempt: 1, launchNo: 2, status: 'live', token: 't', branch: 'task/T2/l2', worktree: '/w', baseSha: 'base2', graphRev: 'r', createdAt: 1 } as const;
    const { markdown, json } = composeBrief(
      {
        launch: launch as unknown as Parameters<typeof composeBrief>[0]['launch'],
        node: { id: 'T2', kind: 'task', payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: [] },
        depReports: [],
        carry: { interrupted: { priorLaunchId: 'L1', priorBranch: 'task/T2/l1', headSha: 'H1', wipCommit: 'W1', reason: 'sessionEnded', interruptions: 1 } },
        apiBaseUrl: 'http://127.0.0.1:1',
        retryWindowMs: 1000,
        checkCommand: 'true',
        integrationBranch: 'main',
      },
      { fallbackPath: '/x' },
    );
    expect(markdown).toContain('launch `L1` was interrupted (sessionEnded)');
    expect(markdown).toContain('branch `task/T2/l1` holds the work so far at `H1`');
    expect(markdown).toContain('commit `W1` is a work-in-progress commit');
    expect(markdown).toContain('squash the work-in-progress commit before submitting');
    expect(json.context).toMatchObject({ interrupted: { priorLaunchId: 'L1', headSha: 'H1', wipCommit: 'W1' } });
  });
});

// See specs/agent-protocol "Check command and tool rules in the brief".
describe('check command and tool rules', () => {
  const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree: '/w', baseSha: 'base1', graphRev: 'r', createdAt: 1 } as const;
  const base = {
    launch: launch as unknown as Parameters<typeof composeBrief>[0]['launch'],
    node: { id: 'T1', kind: 'task' as const, payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: [] },
    depReports: [],
    carry: undefined,
    apiBaseUrl: 'http://127.0.0.1:1',
    retryWindowMs: 1000,
    integrationBranch: 'main',
  };

  it('names the detected command and lists the Bash rules in force for a spawned launch', () => {
    const { markdown, json } = composeBrief({ ...base, checkCommand: 'npm test', allowedTools: [...BASE_RULES, 'Bash(npm test:*)', 'Bash(node:*)'] }, { fallbackPath: '/x' });
    expect(markdown).toContain('Run the check command before submitting: `npm test`');
    expect(markdown).toContain('these Bash rules are in force: `Bash(git:*)`, `Bash(npm test:*)`, `Bash(node:*)`');
    expect(markdown).toContain('runs under its own permissions');
    expect(markdown).toContain('without `cd`');
    expect(markdown).toContain('`needsAccess` question naming the command');
    expect(json.checkCommand).toBe('npm test');
    expect(json.allowedTools).toContain('Bash(npm test:*)');
  });

  it('says no command is configured when unresolved, and lists no rules when none apply', () => {
    const { markdown, json } = composeBrief({ ...base }, { fallbackPath: '/x' });
    expect(markdown).toContain('No check command is configured for this repository yet');
    expect(markdown).toContain('documented test suite before submitting');
    expect(markdown).not.toContain('Run the check command before submitting');
    expect(markdown).not.toContain('Bash rules are in force');
    expect(json.checkCommand).toBeUndefined();
    expect(json.allowedTools).toBeUndefined();
  });

  it('a brief prepared after setConfig names the new command while the earlier brief is unchanged', async () => {
    h = makeHarness({ graph: 'nodes:\n  - { id: A, deps: [], description: d, acceptanceCriteria: [a] }\n  - { id: B, deps: [], description: d, acceptanceCriteria: [a] }', config: { capacity: 1 } });
    await h.orch.tick();
    const first = h.launchOf('A').launchId;
    expect(h.workspace.briefs.get(first)!.checkCommand).toBe('true');
    expect(h.workspace.briefs.get(first)!.allowedTools).toEqual([...BASE_RULES]);
    expect(h.orch.setConfig({ checkCommand: 'make check' })).toMatchObject({ ok: true });
    await h.submit('A', { acceptance: [{ criterion: 'a', evidence: 'done' }] });
    await h.orch.settle();
    expect(h.statusOf('A')).toBe('done');
    expect(h.statusOf('B')).toBe('running');
    const second = h.workspace.briefs.get(h.launchOf('B').launchId)!;
    expect(second.checkCommand).toBe('make check');
    expect(composeBrief(second, { fallbackPath: '/x' }).markdown).toContain('`make check`');
    expect(h.workspace.briefs.get(first)!.checkCommand).toBe('true');
  });

  // See specs/worker-runners "Runner dispatch by launch kind" (a task-level selector).
  it('in a mixed run a codex task gets no Bash rules while a default task keeps the base rules', async () => {
    h = makeHarness({ graph: 'nodes:\n  - { id: C, deps: [], description: d, acceptanceCriteria: [a], runner: codex }\n  - { id: P, deps: [], description: d, acceptanceCriteria: [a] }', config: { capacity: 2 } });
    await h.orch.tick();
    const codex = h.workspace.briefs.get(h.launchOf('C').launchId)!;
    expect(codex.runner).toMatchObject({ kind: 'codex' });
    expect(codex.allowedTools).toBeUndefined();
    expect(composeBrief(codex, { fallbackPath: '/x' }).markdown).not.toContain('Bash rules are in force');
    const plain = h.workspace.briefs.get(h.launchOf('P').launchId)!;
    expect(plain.runner).toMatchObject({ kind: 'claude-code' });
    expect(plain.allowedTools).toEqual([...BASE_RULES]);
    expect(composeBrief(plain, { fallbackPath: '/x' }).markdown).toContain('Bash rules are in force');
  });
});

// See specs/worker-runners "Sandbox and commit policy" and specs/agent-protocol "Standalone brief".
describe('runner-specific brief text', () => {
  const launch = { launchId: 'L2', taskId: 'T2', attempt: 1, launchNo: 2, status: 'live', token: 't', branch: 'task/T2/l2', worktree: '/w', baseSha: 'base2', graphRev: 'r', createdAt: 1 } as const;
  const carry = {
    interrupted: { priorLaunchId: 'L1', priorBranch: 'task/T2/l1', headSha: 'H1', wipCommit: 'W1', reason: 'sessionEnded', interruptions: 1 },
    conflict: { previousBranch: 'task/T2/l0', files: ['src/a.ts'], since: ['T1'] },
    revision: { cause: 'reopened', priorLaunchId: 'L1', priorBranch: 'task/T2/l1' },
  };
  const base = {
    launch: launch as unknown as Parameters<typeof composeBrief>[0]['launch'],
    node: { id: 'T2', kind: 'task' as const, payload: { title: 'x', description: 'd', acceptanceCriteria: ['a'] }, deps: [] },
    depReports: [],
    carry,
    apiBaseUrl: 'http://127.0.0.1:1',
    retryWindowMs: 1000,
    checkCommand: 'npm test',
    integrationBranch: 'main',
  };
  const gitWrites = ['commit and resubmit', 'You may rebase', 'Rebase that branch or start over', 'squash the work-in-progress commit', 'commit the delta'];
  const section = (md: string, name: string) => md.split(`## ${name}\n`)[1]!.split('\n## ')[0]!;

  it('a codex launch under daemon commits gets the sandbox paragraph and read-only git text', () => {
    const { markdown, json } = composeBrief({ ...base, runner: { kind: 'codex', sandbox: 'workspace-write', commitPolicy: 'daemon' } }, { fallbackPath: '/x' });
    expect(markdown).toContain('You run under the Codex sandbox `workspace-write` with approvals disabled');
    expect(markdown).toContain("fails with 'Operation not permitted' and will not be approved at runtime. Do not retry it; ask with a `needsAccess` question naming the command.");
    expect(markdown).toContain('change `runner.codex.sandbox` for your next launch');
    expect(markdown).toContain('the orchestrator commits what is uncommitted when it accepts your report');
    expect(markdown).toContain('The orchestrator rebases your branch onto the integration head at verification');
    expect(markdown).toContain('Never merge into, push to, or check out `main`');
    expect(markdown).toContain('reapply its changes as file edits');
    expect(markdown).toContain('leave the delta in the worktree for the orchestrator to commit');
    expect(markdown).not.toContain('Bash rules are in force');
    // The sandbox blocks a command's network access, so reporting goes through the MCP server (found by the codex e2e).
    expect(section(markdown, 'Reporting')).toContain("through the `orchestrator` MCP server's tools");
    expect(section(markdown, 'Reporting')).toContain('Do not call the API from a command');
    for (const s of gitWrites) expect(markdown, s).not.toContain(s);
    expect(json.runner).toEqual({ kind: 'codex', sandbox: 'workspace-write', commitPolicy: 'daemon' });
    expect(json.allowedTools).toBeUndefined();
  });

  it('a codex launch under agent commits keeps the git-write sentences and names its sandbox', () => {
    const { markdown } = composeBrief({ ...base, runner: { kind: 'codex', sandbox: 'danger-full-access', commitPolicy: 'agent' } }, { fallbackPath: '/x' });
    expect(markdown).toContain('You run under the Codex sandbox `danger-full-access` with approvals disabled');
    for (const s of gitWrites) expect(markdown, s).toContain(s);
    expect(markdown).not.toContain('orchestrator commits what is uncommitted');
  });

  it('a claude-code launch and a brief without a runner write the same Definition of done and Workspace sections', () => {
    const allowedTools = [...BASE_RULES, 'Bash(npm test:*)'];
    const claude = composeBrief({ ...base, allowedTools, runner: { kind: 'claude-code', commitPolicy: 'agent' } }, { fallbackPath: '/x' }).markdown;
    const plain = composeBrief({ ...base, allowedTools }, { fallbackPath: '/x' }).markdown;
    for (const name of ['Definition of done', 'Workspace']) expect(section(claude, name), name).toBe(section(plain, name));
    expect(claude).toBe(plain);
    expect(claude).toContain('these Bash rules are in force: `Bash(git:*)`');
    expect(claude).not.toContain('Codex sandbox');
    expect(claude).not.toContain('MCP server');
    for (const s of gitWrites) expect(claude, s).toContain(s);
  });

  it('a claude-code launch under daemon commits gets the daemon text without a sandbox paragraph', () => {
    const { markdown } = composeBrief({ ...base, runner: { kind: 'claude-code', commitPolicy: 'daemon' } }, { fallbackPath: '/x' });
    expect(markdown).toContain('the orchestrator commits what is uncommitted when it accepts your report');
    expect(markdown).not.toContain('Codex sandbox');
    for (const s of gitWrites) expect(markdown, s).not.toContain(s);
  });
});

// Golden briefs in test/fixtures/brief: the claude-code and codex files were written by the compose before opencode had a branch.
// See specs/agent-protocol "Standalone brief" and "Check command and tool rules in the brief".
describe('golden briefs per kind', () => {
  const golden = (name: string) => readFileSync(path.join(fixtures, `${name}.md`), 'utf8');
  const launch = { launchId: 'L1', taskId: 'T1', attempt: 1, launchNo: 1, status: 'live', token: 't', branch: 'task/T1/l1', worktree: '/w', baseSha: 'base1', graphRev: 'r', createdAt: 1 } as const;
  const base = {
    launch: launch as unknown as Parameters<typeof composeBrief>[0]['launch'],
    node: { id: 'T1', kind: 'task' as const, payload: { title: 'Golden', description: 'Do the golden task.', acceptanceCriteria: ['it works'] }, deps: [] },
    depReports: [],
    apiBaseUrl: 'http://127.0.0.1:1',
    retryWindowMs: 120000,
    checkCommand: 'npm test',
    integrationBranch: 'main',
  };
  const compose = (input: Partial<Parameters<typeof composeBrief>[0]>) => composeBrief({ ...base, ...input }, { fallbackPath: '/w/.orchestrator/report.json' }).markdown;
  const tools = ['heartbeat', 'report', 'block', 'inbox', 'log'];

  it('the claude-code and codex briefs are unchanged', () => {
    expect(compose({ allowedTools: ['Bash(git:*)', 'Bash(npm test:*)', 'Bash(git status)'], runner: { kind: 'claude-code', commitPolicy: 'agent' } })).toBe(golden('claude-code'));
    expect(compose({ runner: { kind: 'codex', commitPolicy: 'daemon', sandbox: 'workspace-write' } })).toBe(golden('codex'));
  });

  it('an opencode brief under derived names the orchestrator_ tools, the rejection wording and the derived patterns', () => {
    const md = compose({ runner: { kind: 'opencode', commitPolicy: 'agent', permission: { mode: 'derived', bashPatterns: ['npm test *', 'git status'] } } });
    expect(md).toBe(golden('opencode-derived'));
    for (const t of tools) expect(md).toContain(`\`orchestrator_${t}\``);
    expect(md).toContain("fails with 'The user rejected permission to use this specific tool call.' and will not be approved at runtime");
    expect(md).toContain('`needsAccess` question naming the command');
    expect(md).toContain('these bash commands: `npm test *`, `git status`');
    expect(md).not.toMatch(/sandbox/i);
    expect(md).not.toContain('mcp__orchestrator__');
    expect(md).not.toContain('Do not call the API from a command');
    expect(md).toContain('- API: `http://127.0.0.1:1/v1/launches/L1/...`');
    expect(md).toContain('commit and resubmit');
    // A retry brief after a runner failure names permission rules, not a sandbox.
    const retry = compose({ carry: { priorFailure: { detail: { runnerFailure: { reason: 'permissionDenied' } } } }, runner: { kind: 'opencode', commitPolicy: 'agent', permission: { mode: 'derived' } } });
    expect(retry).toContain('(model, login, MCP setup, permission rules)');
    expect(retry).not.toMatch(/sandbox/i);
  });

  it('an opencode brief under allow says every command is allowed and lists no patterns', () => {
    const md = compose({ runner: { kind: 'opencode', commitPolicy: 'agent', permission: { mode: 'allow' } } });
    expect(md).toBe(golden('opencode-allow'));
    expect(md).toContain('the rules allow every command and every tool.');
    expect(md).not.toContain('these bash commands');
    expect(md).not.toMatch(/sandbox/i);
    expect(md).not.toContain('mcp__orchestrator__');
  });
});

// See specs/worker-runners "Sandbox and commit policy".
describe('opencode launches: permission in the brief input and commit policy', () => {
  const graph = 'nodes:\n  - { id: O, deps: [], description: d, acceptanceCriteria: [a], runner: opencode }';
  const done = { acceptance: [{ criterion: 'a', evidence: 'done' }] };

  it('fills the derived bash patterns, git first, and no allowedTools or sandbox', async () => {
    h = makeHarness({ graph, config: { runner: { claude: { allowedTools: ['Bash(npm test:*)', 'Bash(git status)'] } } } });
    await h.orch.tick();
    const brief = h.workspace.briefs.get(h.launchOf('O').launchId)!;
    expect(brief.allowedTools).toBeUndefined();
    expect(brief.runner).toEqual({ kind: 'opencode', commitPolicy: 'agent', permission: { mode: 'derived', bashPatterns: expect.arrayContaining(['git *', 'npm test *', 'git status']) } });
    expect(brief.runner?.permission?.bashPatterns?.[0]).toBe('git *');
    expect(new Set(brief.runner?.permission?.bashPatterns).size).toBe(brief.runner?.permission?.bashPatterns?.length);
    const md = composeBrief(brief, { fallbackPath: '/x' }).markdown;
    expect(md).toContain('`npm test *`');
    expect(md).toContain('`git status`');
  });

  it('under permission: allow fills no patterns', async () => {
    h = makeHarness({ graph, config: { runner: { opencode: { permission: 'allow' } } } });
    await h.orch.tick();
    expect(h.workspace.briefs.get(h.launchOf('O').launchId)!.runner).toEqual({ kind: 'opencode', commitPolicy: 'agent', permission: { mode: 'allow' } });
  });

  it('commits as the agent by default: no ORCH_COMMIT_POLICY and the daemon does not commit at submit', async () => {
    h = makeHarness({ graph });
    expect(h.orch.commitPolicyFor('opencode')).toBe('agent');
    await h.orch.tick();
    const l = h.launchOf('O');
    expect(l).toMatchObject({ runner: 'opencode', commitPolicy: 'agent' });
    expect(h.orch.agentEnv(l)).not.toHaveProperty('ORCH_COMMIT_POLICY');
    expect(composeBrief(h.workspace.briefs.get(l.launchId)!, { fallbackPath: '/x' }).markdown).toContain('commit and resubmit');
    expect(await h.submit('O', done)).toMatchObject({ status: 200, body: { accepted: true } });
    expect(h.workspace.autoCommits).toEqual([]);
  });

  it('under runner.opencode.commit: daemon the shim gets the daemon variant and the daemon seals a dirty submit', async () => {
    h = makeHarness({ graph, config: { runner: { opencode: { commit: 'daemon' } } } });
    expect(h.orch.commitPolicyFor('opencode')).toBe('daemon');
    await h.orch.tick();
    const l = h.launchOf('O');
    expect(l).toMatchObject({ runner: 'opencode', commitPolicy: 'daemon' });
    // The shim phrases its report tool from this variable (test/slice/shim.test.ts covers the wording).
    expect(h.orch.agentEnv(l)['ORCH_COMMIT_POLICY']).toBe('daemon');
    expect(composeBrief(h.workspace.briefs.get(l.launchId)!, { fallbackPath: '/x' }).markdown).toContain('the orchestrator commits what is uncommitted when it accepts your report');
    h.workspace.markProgress(l.launchId, 'wip', true);
    expect(await h.submit('O', done)).toMatchObject({ status: 200, body: { accepted: true, sealedSha: `auto-${l.launchId.slice(0, 8)}` } });
    expect(h.workspace.autoCommits).toMatchObject([{ launchId: l.launchId }]);
    expect(h.store.listEvents({ kind: 'agent.report', taskId: 'O' })[0]?.payload).toMatchObject({ committedByOrchestrator: true });
  });
});

describe('slot validation', () => {
  it('reports missing required slots; arrays count; milestones are skipped', () => {
    const g = parseGraph(graph);
    const v = new SlotValidator();
    expect(v.validate(g.nodes.get('A')!, g.nodes.get('A')!.payload)).toEqual({ ok: false, missing: ['acceptanceCriteria'] });
    expect(v.validate(g.nodes.get('B')!, g.nodes.get('B')!.payload)).toEqual({ ok: true });
    expect(v.validate(g.nodes.get('M')!, {})).toEqual({ ok: true });
    expect(slotValue({ x: ['a', ' ', 'b'] }, 'x')).toBe('a\nb');
    expect(new SlotValidator({ d: { source: 'description', required: true, minLength: 10 } }).validate(g.nodes.get('A')!, g.nodes.get('A')!.payload)).toEqual({ ok: false, missing: ['d'] });
  });

  it('blocks a ready task with the missing slot list (policy block)', async () => {
    h = withValidator({ graph });
    await h.orch.tick();
    expect(h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { kind: 'insufficientSpec', missing: ['acceptanceCriteria'] } });
    expect(h.statusOf('B')).toBe('running');
    expect(h.orch.status().stallRoots).toContain('A');
  });

  it('review mode lands the candidate as needsDecision; unblock applies it', async () => {
    const rem = new StaticRemediator(() => ['remediated criterion']);
    h = withValidator({ graph, config: { onInsufficient: 'remediate', remediateMode: 'review' } }, rem);
    await h.orch.tick();
    expect(rem.calls).toEqual([{ taskId: 'A', missing: ['acceptanceCriteria'] }]);
    expect(h.orch.entry('A').status).toMatchObject({ kind: 'blocked', reason: { kind: 'needsDecision', candidate: { acceptanceCriteria: ['remediated criterion'] } } });
    expect(h.orch.unblock('A', { acceptCandidate: true })).toEqual({ ok: true });
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('running');
    const brief = h.workspace.briefs.get(h.launchOf('A').launchId)!;
    expect(brief.node.payload['acceptanceCriteria']).toEqual(['remediated criterion']);
    expect(h.store.getPayloadOverlay('A', h.orch.graph().rev)).toEqual({ acceptanceCriteria: ['remediated criterion'] });
    const { json } = composeBrief(brief, { fallbackPath: '/x' });
    expect(json.acceptanceCriteria).toEqual(['remediated criterion']);
  });

  it('auto mode launches directly with the candidate applied', async () => {
    h = withValidator({ graph, config: { onInsufficient: 'remediate', remediateMode: 'auto' } }, new StaticRemediator());
    await h.orch.tick();
    expect(h.statusOf('A')).toBe('running');
    expect(h.workspace.briefs.get(h.launchOf('A').launchId)!.node.payload['acceptanceCriteria']).toBe('candidate acceptanceCriteria');
  });

  it('strict ingest mode rejects the whole graph', async () => {
    h = withValidator({ graph, config: { validateAt: 'ingest' } });
    await h.orch.tick();
    expect(h.orch.hasGraph()).toBe(false);
    expect(h.store.listEvents({ kind: 'graph.rejected' })[0]?.payload?.['reasons']).toEqual(['A: missing acceptanceCriteria']);
    expect(h.store.listLaunches()).toEqual([]);
  });
});
