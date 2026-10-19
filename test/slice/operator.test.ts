import { createServer } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
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
    expect((await cli('status')).body).toMatchObject({ paused: true, pausedReason: 'operator' });
    expect((await cli('resume', '--override-budget')).body).toMatchObject({ ok: true, paused: false });
    expect((await cli('nudge', 'T5', 'commit', 'what', 'you', 'have')).body).toEqual({ ok: true });
    expect(h.store.getLaunch(h.launchOf('T5').launchId)?.notices).toEqual([{ kind: 'nudge', message: 'commit what you have' }]);
    expect((await cli('nudge', 'T2', 'hello')).status).toBe(409);
    expect((await cli('answer', 'T1', 'option', 'b')).body).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done', 20_000);
    const refused = await cli('reopen', 'T1');
    expect(refused.status).toBe(409); // T2 is started
    expect(refused.body).toMatchObject({ ok: false, blockers: ['T2'] });
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
    for (const k of ['operator.pause', 'operator.resume', 'operator.nudge', 'operator.answer', 'operator.reject', 'operator.unblock', 'operator.cancel']) expect(kinds).toContain(k);
    await expect(runCli(['bogus', '--url', url])).rejects.toThrow(/unknown command/);
  });

  it('outbox and ack commands reach the outbox routes', async () => {
    const tracked = `nodes:
  - { id: T1, deps: [], behavior: hang, url: "https://tracker.example/T1" }
  - { id: T2, deps: [], behavior: hang, url: "https://tracker.example/T2" }`;
    h = await makeSlice({
      graph: tracked,
      config: { leaseTtlMs: 60_000, tracker: { enabled: 'always', maxAttempts: 3, parentInProgress: true, commentOnDone: false, commentOnFail: false, doneAt: 'integration', answersFromComments: true } },
    });
    const url = h.orch.apiBaseUrl;
    const cli = (...args: string[]) => runCli([...args, '--url', url]);
    await h.orch.tick();
    const listed = await cli('outbox');
    expect(listed.status).toBe(200);
    const effects = (listed.body as { effects: Array<{ id: number; taskId: string }> }).effects;
    expect(effects.map((e) => e.taskId)).toEqual(['T1', 'T2']);
    const [first, second] = effects;
    expect((await cli('ack', String(first!.id), '--result', '{"stateId":"s1"}')).body).toMatchObject({ ok: true, effect: { status: 'applied', result: { stateId: 's1' } } });
    expect((await cli('ack', String(second!.id), '--error', 'no such state')).body).toMatchObject({ ok: true, effect: { status: 'pending', attempts: 1, error: 'no such state' } });
    const paged = await cli('outbox', '--after', String(first!.id), '--limit', '1');
    expect((paged.body as { effects: Array<{ id: number }> }).effects.map((e) => e.id)).toEqual([second!.id]);
    await expect(cli('ack')).rejects.toThrow(/effect id/);
  });

  it('reopen --cascade returns the plan and the tick applies it', async () => {
    h = await makeSlice({ graph: `nodes:\n  - { id: T1, deps: [], behavior: commitAndSubmit }\n  - { id: T2, deps: [T1], behavior: hang }`, config: { leaseTtlMs: 60_000 } });
    const url = h.orch.apiBaseUrl;
    const cli = (...args: string[]) => runCli([...args, '--url', url]);
    await h.waitFor(() => h!.orch.entry('T2').status.kind === 'running', 20_000);
    const l2 = h.launchOf('T2');
    const r = await cli('reopen', 'T1', '--cascade');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, reset: expect.arrayContaining([{ id: 'T2', from: 'running' }, { id: 'T1', from: 'done' }]) });
    expect(h.store.listEvents({ kind: 'operator.reopen' }).at(-1)?.payload).toMatchObject({ cascade: true });
    await h.orch.tick();
    expect(h.store.getLaunch(l2.launchId)).toMatchObject({ status: 'ended', endReason: 'cascade' });
    expect(h.orch.entry('T2')).toMatchObject({ status: { kind: 'unstarted' }, attempts: 0 });
    expect((await cli('proposals')).body).toEqual({ proposals: [] });
    expect((await cli('reject-proposal', 'NOPE', '--note', 'x')).status).toBe(404);
  }, 40_000);

  it('status lists a deferred candidate with the ids its scope overlaps', async () => {
    h = await makeSlice({
      graph: `nodes:\n  - { id: A, deps: [], behavior: hang, scope: ["src/**"] }\n  - { id: B, deps: [], behavior: hang, scope: ["src/api/**"] }\n  - { id: C, deps: [], behavior: hang, scope: ["docs/**"] }`,
      config: { leaseTtlMs: 60_000 },
    });
    const url = h.orch.apiBaseUrl;
    const cli = (...args: string[]) => runCli([...args, '--url', url]);
    await h.orch.tick();
    const status = await cli('status');
    expect(status.body).toMatchObject({ byStatus: { running: ['A', 'C'], unstarted: ['B'] }, deferred: [{ id: 'B', reason: 'scopeOverlap', with: ['A'] }] });
    expect((await cli('cancel', 'A', '--reason', 'make room')).body).toEqual({ ok: true });
    await h.waitFor(() => h!.orch.entry('B').status.kind === 'running');
    expect((await cli('status')).body).toMatchObject({ deferred: [] });
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

  it('config --data-dir refuses a mistyped leaf when the daemon is addressed by url, and still names the store without one', async () => {
    const seen: string[] = [];
    const stub = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ config: {} }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    const prior = process.env['ORCH_URL'];
    try {
      await expect(runCli(['--url', stubUrl, 'config', '--data-dir', 'lanch'])).rejects.toThrow(/--data-dir lanch.*opencode\.dataDir \(shared or launch\).*store location/);
      process.env['ORCH_URL'] = stubUrl;
      await expect(runCli(['config', '--data-dir', 'lanch'])).rejects.toThrow(/shared or launch/);
      expect(seen).toEqual([]);
      await runCli(['config', '--data-dir', 'launch']);
      expect(seen).toEqual(['PUT /v1/config']);

      // Without a url, any other value still names the store whose recorded daemon url is used.
      delete process.env['ORCH_URL'];
      h = await makeSlice({ graph: single('hang'), config: { leaseTtlMs: 60_000 } });
      h.store.setKv('apiBaseUrl', h.orch.apiBaseUrl);
      const viaStore = await runCli(['config', '--data-dir', path.dirname(h.graphPath)]);
      expect(viaStore.status).toBe(200);
      expect(viaStore.body).toMatchObject({ config: { runnerKind: { value: 'claude-code' } } });
    } finally {
      if (prior === undefined) delete process.env['ORCH_URL'];
      else process.env['ORCH_URL'] = prior;
      stub.close();
    }
  });
});
