/**
 * The Claude worker image, asserted from `deploy/worker-claude/Dockerfile` without a Docker daemon (ORC-31 builds it).
 * See specs/cluster-runtime "Claude worker image".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeAgentCommand } from '../../src/worker/loop.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const text = read('deploy/worker-claude/Dockerfile');

/** The Dockerfile's instructions: comments dropped, continuations joined, one per entry. */
const instructions = text
  .replace(/\\\n/g, ' ')
  .split('\n')
  .map((l) => l.trim().replace(/\s+/g, ' '))
  .filter((l) => l && !l.startsWith('#'));
const keyword = (i: string) => i.split(' ')[0]!.toUpperCase();
const indexOf = (pred: (i: string) => boolean) => instructions.findIndex(pred);

/** Every variable the ENV instructions set, quotes removed. */
const envVars: Record<string, string> = {};
for (const i of instructions.filter((x) => keyword(x) === 'ENV')) {
  for (const m of i.slice(4).matchAll(/(\w+)=("((?:[^"\\]|\\.)*)"|\S+)/g)) envVars[m[1]!] = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2]!;
}

describe('Claude worker image', () => {
  it('starts with ARG PROJECT_BASE and has one stage FROM it', () => {
    expect(instructions[0]).toBe('ARG PROJECT_BASE=orchestrator:dev');
    const froms = instructions.filter((i) => keyword(i) === 'FROM');
    expect(froms).toEqual(['FROM ${PROJECT_BASE}']);
  });

  it('installs the Claude Code CLI as root at CLAUDE_CODE_VERSION, set after FROM, then returns to node', () => {
    const from = indexOf((i) => keyword(i) === 'FROM');
    const version = indexOf((i) => /^ARG CLAUDE_CODE_VERSION(=|$)/.test(i));
    const root = indexOf((i) => i === 'USER root');
    const install = indexOf((i) => keyword(i) === 'RUN' && i.includes('npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}'));
    expect(from).toBeGreaterThan(0);
    expect(version).toBeGreaterThan(from);
    expect(root).toBeGreaterThan(version);
    expect(install).toBeGreaterThan(root);
    const users = instructions.filter((i) => keyword(i) === 'USER');
    expect(users.at(-1)).toBe('USER node');
    expect(indexOf((i) => i === 'USER node')).toBeGreaterThan(install);
  });

  it('runs orchestrator-worker in exec form, with no ENTRYPOINT', () => {
    expect(instructions.filter((i) => keyword(i) === 'CMD')).toEqual(['CMD ["orchestrator-worker"]']);
    expect(instructions.some((i) => keyword(i) === 'ENTRYPOINT')).toBe(false);
  });

  it('sets the git identity and DISABLE_AUTOUPDATER=1, and holds no ANTHROPIC_ variable or key', () => {
    expect(envVars).toMatchObject({
      GIT_AUTHOR_NAME: 'orchestrator-worker',
      GIT_COMMITTER_NAME: 'orchestrator-worker',
      GIT_AUTHOR_EMAIL: 'worker@orchestrator.local',
      GIT_COMMITTER_EMAIL: 'worker@orchestrator.local',
      DISABLE_AUTOUPDATER: '1',
    });
    for (const line of text.split('\n')) expect(line).not.toContain('ANTHROPIC_');
  });

  it('sets ORCH_WORKER_COMMAND to the Claude template without {allowedTools}, and the loop fills every slot', () => {
    const command = envVars['ORCH_WORKER_COMMAND'];
    expect(command).toBeDefined();
    for (const part of ['--mcp-config {mcpConfig}', '--strict-mcp-config', '--output-format json', '--dangerously-skip-permissions', '--model {model}', '--effort {effort}', '--no-session-persistence', '< {brief}']) {
      expect(command).toContain(part);
    }
    expect(command).not.toContain('{allowedTools}');
    const composed = composeAgentCommand(command!, { launchId: 'L1', taskId: 'T1', model: 'claude-opus-5-5', effort: 'high', brief: {} }, '/var/cache/orchestrator/repo');
    expect(composed).not.toMatch(/\{\w+\}/);
    expect(composed).toContain('--mcp-config /var/cache/orchestrator/repo/.orchestrator/mcp.json');
    expect(composed).toContain('--model claude-opus-5-5 --effort high');
    expect(composed).toContain('< /var/cache/orchestrator/repo/.orchestrator/brief.md');
  });

  it('deploy/README.md describes the image and says the shim pushes and names sealedSha', () => {
    const readme = read('deploy/README.md');
    const section = readme.slice(readme.indexOf('### Claude worker image'));
    expect(readme).toContain('### Claude worker image');
    for (const s of ['orchestrator-worker-claude:dev', 'docker build -f deploy/worker-claude/Dockerfile -t orchestrator-worker-claude:dev deploy/worker-claude', 'PROJECT_BASE', 'CLAUDE_CODE_VERSION', 'ORCH_WORKER_COMMAND', '--dangerously-skip-permissions', 'orchestrator-worker', 'worker@orchestrator.local']) {
      expect(section).toContain(s);
    }
    const workers = readme.slice(readme.indexOf('### The workers'), readme.indexOf('#### The run id'));
    expect(workers).toContain('`sealedSha`');
    expect(workers).toMatch(/shim's `report` tool/);
  });
});
