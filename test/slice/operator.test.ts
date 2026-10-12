import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/operator/cli.js';
import { pidAlive } from '../../src/runner/subprocess.js';
import { makeSlice, single, type SliceHarness } from './harness.js';

let h: SliceHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const G = `nodes:
  - { id: T1, deps: [], behavior: blockAndWait:pick }
  - { id: T2, deps: [T1], behavior: commitAndSubmit }
  - { id: T5, deps: [], behavior: hang }
  - { id: MVP, kind: milestone, gated: true, deps: [T2] }`;

describe('operator CLI and routes', () => {
  it('every command produces its event and the status report is complete', async () => {
    h = await makeSlice({ graph: G, config: { leaseTtlMs: 60_000 } });
    const url = h.orch.apiBaseUrl;
    const cli = (...args: string[]) => runCli([...args, '--url', url]);
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'waiting');

    const status = await cli('status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ openQuestions: ['T1'], byStatus: { waiting: ['T1'], running: ['T5'] }, paused: false, graphRev: h.orch.graph().rev, foreignCommits: [] });

    expect((await cli('pause')).body).toMatchObject({ ok: true, paused: true });
    expect((await cli('resume')).body).toMatchObject({ ok: true, paused: false });
    expect((await cli('answer', 'T1', 'option', 'b')).body).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 20_000);
    expect((await cli('reopen', 'T1')).status).toBe(409); // T2 is started
    await h.waitFor(() => h!.orch.entry('MVP').status.kind === 'submitted', 20_000);
    const mvp = h.orch.entry('MVP');
    expect((await cli('accept', 'MVP', '--sha', mvp.integrationSha!, '--version', '7')).status).toBe(409);
    expect((await cli('reject', 'MVP')).status).toBe(409); // note required
    expect((await cli('reject', 'MVP', '--note', 'demo failed')).body).toEqual({ ok: true });
    expect(h.orch.entry('MVP').status).toMatchObject({ kind: 'blocked', reason: { kind: 'milestoneRejected', note: 'demo failed' } });
    expect((await cli('unblock', 'MVP')).body).toEqual({ ok: true });
    expect((await cli('cancel', 'T5', '--release', '--reason', 'not needed')).body).toEqual({ ok: true });
    const logs = await cli('logs', 'T2');
    expect(logs.status).toBe(200);
    expect(logs.body).toMatchObject({ launchNo: 1 });
    expect((await cli('logs', 'NOPE')).status).toBe(404);

    const kinds = h.store.listEvents().map((e) => e.kind);
    for (const k of ['operator.pause', 'operator.resume', 'operator.answer', 'operator.reject', 'operator.unblock', 'operator.cancel']) expect(kinds).toContain(k);
    await expect(runCli(['bogus', '--url', url])).rejects.toThrow(/unknown command/);
  });

  it('graceful stop keeps agents for adoption; --reap stops them', async () => {
    h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000 } });
    await h.orch.tick();
    const l = h.launchOf('T1');
    await h.orch.stop();
    expect(pidAlive(l.pid!)).toBe(true);
    await h.restart();
    expect(h.store.getLaunch(l.launchId)?.status).toBe('live');
    expect(h.orch.entry('T1').status.kind).toBe('running');
    await h.orch.stop({ reap: true });
    for (let i = 0; i < 40 && pidAlive(l.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(pidAlive(l.pid!)).toBe(false);
    expect(h.store.getLaunch(l.launchId)?.status).toBe('ended');
    const failed = h.store.listEvents({ kind: 'transition', taskId: 'T1' }).find((e) => e.payload?.['to'] === 'failed');
    expect(failed).toBeDefined();
    expect(h.orch.entry('T1').carry?.priorFailure?.kind).toBe('reaped');
  });
});
