/**
 * Opt-in end to end with Codex as the operator session: ORCH_E2E_CODEX_OPERATOR=1 npm test -- test/e2e/codex-operator
 * Costs tokens and needs a logged-in `codex` (codex-cli 0.163.0 when written). `codex exec` drives a run
 * through the operator MCP server, registered with `-c mcp_servers.orchestrator_operator.*` overrides as
 * hosts/codex/config.toml does, with every operator tool pre-approved, since `codex exec` cannot prompt.
 * The daemon runs in spawn mode with scripted agents, so only the operator spends tokens.
 * See specs/host-integration "Codex host".
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/operator/mcp-server.js';
import { listRuns, stopDaemon } from '../../src/runs/lifecycle.js';
import { gitIn, makeRepo, scriptedAgent, tsxLoader } from '../slice/harness.js';

const enabled = process.env['ORCH_E2E_CODEX_OPERATOR'] === '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const launcher = path.join(root, 'hosts/codex/bin/orchestrator.mjs');
const ID = 'orchestrator_operator';
const ANSWER = 'b';

const graph = ['nodes:',
  '  - { id: T1, deps: [], behavior: "blockAndWait:pick", description: d, acceptanceCriteria: [a] }',
  '  - { id: T2, deps: [T1], behavior: commitAndSubmit, description: d, acceptanceCriteria: [b] }', ''].join('\n');

const prompt = `You are the operator of an orchestrator run. Use only the tools of the ${ID} MCP server; run no shell commands.
1. Call start with mode "spawn".
2. Call import_graph with content set to exactly this YAML:
${graph}
3. Loop: call wait with until "any" and timeoutMs 60000, passing afterSeq set to the seq the previous wait returned (omit it the first time).
   After each return, look at digest.openQuestions: for each task id there, call answer with that task and text "${ANSWER}" (once per task).
   Stop looping when digest.finished is true.
4. Call stop. Then reply with the single word FINISHED.`;

interface Item {
  type?: string;
  server?: string;
  tool?: string;
  status?: string;
  result?: { content?: Array<{ text?: string }> } | null;
}

function events(text: string): Array<{ type?: string; item?: Item }> {
  const out: Array<{ type?: string; item?: Item }> = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t) as { type?: string; item?: Item });
    } catch {
      // a partial or non-event line
    }
  }
  return out;
}

function resultJson(item: Item): Record<string, unknown> | undefined {
  for (const c of item.result?.content ?? []) {
    try {
      return JSON.parse(c.text ?? '') as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  return undefined;
}

function codexOnPath(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
}

const toml = (s: string) => JSON.stringify(s);

/** The registration of hosts/codex/config.toml as -c overrides, plus the approvals `codex exec` needs. */
function operatorOverrides(env: Record<string, string>): string[] {
  const table = `{${Object.entries(env).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`;
  return [
    'approval_policy="never"',
    `mcp_servers.${ID}.command="node"`,
    `mcp_servers.${ID}.args=[${toml(launcher)},"mcp"]`,
    `mcp_servers.${ID}.env=${table}`,
    `mcp_servers.${ID}.required=true`,
    `mcp_servers.${ID}.startup_timeout_sec=30`,
    `mcp_servers.${ID}.tool_timeout_sec=180`,
    `mcp_servers.${ID}.default_tools_approval_mode="approve"`,
    ...TOOL_NAMES.map((t) => `mcp_servers.${ID}.tools.${t}.approval_mode="approve"`),
  ].flatMap((o) => ['-c', o]);
}

describe.skipIf(!enabled)('e2e with Codex as the operator', () => {
  it('codex exec starts a spawn-mode run, answers its question, and waits until it finishes', async () => {
    if (!codexOnPath()) {
      console.warn('codex CLI not installed; codex operator e2e skipped');
      return;
    }
    const home = mkdtempSync(path.join(tmpdir(), 'orch-codex-op-home-'));
    const base = mkdtempSync(path.join(tmpdir(), 'orch-codex-op-repo-'));
    const repo = realpathSync(makeRepo(base));
    writeFileSync(path.join(repo, 'orchestrator.yaml'), [
      `runnerCommand: "node --import ${tsxLoader} ${scriptedAgent} {briefJson}"`,
      'checkCommand: "true"', 'tickIntervalMs: 150', 'leaseTtlMs: 60000', 'retryWindowMs: 5000', 'capacity: 2',
    ].join('\n'));
    gitIn(repo, 'add', 'orchestrator.yaml');
    gitIn(repo, 'commit', '-m', 'orchestrator config');
    // Codex hands an MCP server only a fixed set of variables plus its env table.
    const serverEnv = { ORCH_HOME: home, ORCH_REPO: repo, PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' };
    const env = { ...(process.env as Record<string, string>), ORCH_HOME: home, ORCH_REPO: repo };
    let log = '';
    try {
      const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-C', repo, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="low"', '-s', 'read-only', ...operatorOverrides(serverEnv), '-'];
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('codex', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => (log += d.toString()));
        child.stderr.on('data', (d: Buffer) => (log += d.toString()));
        child.on('error', reject);
        child.on('exit', resolve);
        child.stdin.end(prompt);
      });
      const items = events(log).filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').map((e) => e.item!);
      const diag = JSON.stringify({ code, tail: log.slice(-4000) });
      expect(code, diag).toBe(0);
      expect(items.length, diag).toBeGreaterThan(0);
      for (const i of items) expect(i.server, diag).toBe(ID);
      const used = new Set(items.map((i) => i.tool));
      for (const t of ['start', 'import_graph', 'wait', 'answer']) expect(used.has(t), `${t} ${diag}`).toBe(true);
      const start = resultJson(items.find((i) => i.tool === 'start')!);
      expect(start, diag).toMatchObject({ mode: 'spawn' });
      const finished = items.filter((i) => i.tool === 'wait').map(resultJson).some((r) => (r?.['digest'] as { finished?: boolean } | undefined)?.finished === true);
      expect(finished, diag).toBe(true);
      expect(gitIn(repo, 'show', `main:T1.txt`).trim()).toBe(`answer: ${ANSWER}`);
    } finally {
      for (const r of await listRuns(env)) if (r.alive && r.repo) await stopDaemon({ repo: r.repo, env, reap: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  }, 15 * 60_000);
});
