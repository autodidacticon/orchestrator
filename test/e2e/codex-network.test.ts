/**
 * Opt-in probe of codex.networkAccess with a real Codex agent: ORCH_E2E_CODEX_NETWORK=1 npm test -- test/e2e/codex-network
 * Costs tokens, needs a logged-in `codex` on PATH, and needs this machine to reach registry.npmjs.org (checked first,
 * from the test process; when it fails the test fails as inconclusive and spends no tokens). A result holds only for
 * the platform and the Codex version it ran on.
 *
 * Two tests, each with its own scratch repository and one task N1 whose agent runs three commands that write
 * net.txt (the registry), api.txt (the daemon's operator API on loopback) and listen.txt (opening a port), each by
 * shell redirection. The control runs without the override and expects no registry access; the probe sets
 * codex.networkAccess true and expects it. api.txt and listen.txt are printed, never asserted.
 * See specs/worker-runners "Codex network access override".
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeCodexCommand, DEFAULT_CODEX_COMMAND } from '../../src/runner/codex.js';
import { freePort, gitIn, makeRepo, makeSlice, type SliceHarness } from '../slice/harness.js';

const enabled = process.env['ORCH_E2E_CODEX_NETWORK'] === '1';
const TIMEOUT_MS = 15 * 60_000;
const FILES = ['net.txt', 'api.txt', 'listen.txt'] as const;

function codexOnPath(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

/** The registry, from the test process and outside any sandbox. Throws when it is not reached: the probe would show nothing. */
function preflight(): void {
  let code = '';
  try {
    code = execFileSync('curl', ['-sS', '-m', '20', '-o', '/dev/null', '-w', '%{http_code}', 'https://registry.npmjs.org/-/ping'], { encoding: 'utf8' }).trim();
  } catch (err) {
    code = String((err as { stdout?: unknown }).stdout ?? '').trim() || `error: ${(err as Error).message}`;
  }
  if (code !== '200') throw new Error(`inconclusive: this machine cannot reach registry.npmjs.org; the probe shows nothing (curl printed ${JSON.stringify(code)})`);
}

const graphFor = (port: number) => {
  const description = [
    'Run each of the following three shell commands exactly once, at the repository root, exactly as written.',
    'Do not retry any of them, do not ask a question, do not edit the files they write afterwards, and leave the files uncommitted.',
    'Then submit your report, whatever the commands printed.',
    `Command 1: curl -sS -m 20 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/-/ping > net.txt; echo " $?" >> net.txt`,
    `Command 2: curl -sS -m 10 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${port}/v1/status?probe=1' > api.txt; echo " $?" >> api.txt`,
    `Command 3: node -e "require('net').createServer().listen(0,'127.0.0.1',function(){console.log('listening');process.exit(0)})" > listen.txt 2>&1; echo " $?" >> listen.txt`,
  ].join('\n');
  return `nodes:\n  - id: N1\n    title: Network probe\n    description: ${JSON.stringify(description)}\n    acceptanceCriteria: ["net.txt, api.txt and listen.txt exist at the repo root"]\n    deps: []\n`;
};

async function probe(networkAccess: boolean): Promise<{ h: SliceHarness; dir: string; files: Record<string, string> }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'orch-codex-net-'));
  const repo = makeRepo(dir);
  const port = await freePort();
  const h = await makeSlice({
    graph: graphFor(port),
    dir,
    repo,
    realVerifier: true,
    kind: 'codex',
    config: { capacity: 1, leaseTtlMs: 10 * 60_000, apiPort: port, checkCommand: 'test -f net.txt', runner: { codex: { command: DEFAULT_CODEX_COMMAND } } },
  });
  try {
    return await run(h, dir, repo, networkAccess);
  } catch (err) {
    // A timeout or a failed assertion must not leave the daemon and a real Codex running.
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function run(h: SliceHarness, dir: string, repo: string, networkAccess: boolean): Promise<{ h: SliceHarness; dir: string; files: Record<string, string> }> {
  if (networkAccess) expect(h.orch.setConfig({ codex: { networkAccess: true } })).toMatchObject({ ok: true, applied: ['codex'] });
  // Any open question is answered at once: the agent must not wait on the session.
  const answered = new Set<string>();
  const respond = () => {
    const s = h.orch.status();
    for (const id of s.openQuestions) {
      const e = h.orch.entry(id);
      const q = e.status.kind === 'waiting' ? e.status.question : e.status.kind === 'blocked' ? e.status.reason : undefined;
      if (!q || answered.has(`${id}:${q.message}`)) continue;
      answered.add(`${id}:${q.message}`);
      const text = 'Do not ask; write the error to the file and submit.';
      if (e.status.kind === 'waiting') h.orch.answer(id, text);
      else h.orch.unblock(id, { answer: text });
    }
    return s.finished || s.stalled;
  };
  await h.waitFor(respond, TIMEOUT_MS - 60_000);
  const files: Record<string, string> = {};
  for (const f of FILES) {
    try {
      files[f] = gitIn(repo, 'show', `main:${f}`).trim();
    } catch {
      files[f] = '<missing>';
    }
  }
  console.log(`codex network probe (networkAccess ${networkAccess}):`, JSON.stringify(files, null, 2));
  return { h, dir, files };
}

describe.skipIf(!enabled)('e2e: codex.networkAccess with a real Codex', () => {
  it(
    'control: without the override, a command does not reach the registry',
    async () => {
      preflight();
      if (!codexOnPath()) {
        console.warn('codex CLI not installed; codex network probe skipped');
        return;
      }
      const { h, dir, files } = await probe(false);
      try {
        expect(h.orch.entry('N1').status.kind).toBe('done');
        const net = files['net.txt']!;
        expect(net, 'net.txt holds an HTTP code and an exit code').toMatch(/^\d{3}\s+\d+$/);
        expect(net, 'the sandbox gave network access without the flag, so the probe shows nothing').not.toMatch(/^200\s+0$/);
      } finally {
        await h.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it(
    'probe: with codex.networkAccess true, the flag is on the command line and a command reaches the registry',
    async () => {
      preflight();
      if (!codexOnPath()) {
        console.warn('codex CLI not installed; codex network probe skipped');
        return;
      }
      const { h, dir, files } = await probe(true);
      try {
        const [launch] = h.store.listLaunches({ taskId: 'N1' });
        expect(launch).toBeDefined();
        expect(composeCodexCommand(launch!, { settings: h.orch.effective().config.runner.codex, maxWaitMs: h.config.maxWaitMs })).toContain('sandbox_workspace_write.network_access=true');
        expect(h.orch.entry('N1').status.kind).toBe('done');
        expect(files['net.txt'], 'net.txt shows the registry reached with exit 0').toMatch(/^200\s+0$/);
      } finally {
        await h.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
