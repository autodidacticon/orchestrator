import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// OpenSpec 2.1 length-checks only the ADDED requirements of a change, so a MODIFIED requirement can grow past
// the limit and fail `openspec validate --strict` only after the archive. This test archives every pending change
// in a temporary copy of openspec/ and validates the specs as they would be left. It changes nothing in the repository.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function skipReason(): string | undefined {
  const r = spawnSync('openspec', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return 'openspec is not on PATH';
  const version = r.stdout.trim();
  if (!/^2\.1\.\d+/.test(version)) return `openspec version is ${version || 'unknown'}, not 2.1.x`;
  return undefined;
}

const reason = skipReason();
if (reason) console.warn(`openspec-strict: skipped: ${reason}`);

interface Issue {
  level: string;
  path: string;
  message: string;
}
interface Item {
  id: string;
  type: string;
  valid: boolean;
  issues: Issue[];
}

function openspec(cwd: string, args: string[]) {
  return spawnSync('openspec', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Pending changes: the directories under openspec/changes other than archive/, in directory order. */
function pendingChanges(dir: string): string[] {
  const changes = path.join(dir, 'openspec', 'changes');
  if (!existsSync(changes)) return [];
  return readdirSync(changes)
    .filter((name) => name !== 'archive' && statSync(path.join(changes, name)).isDirectory())
    .sort();
}

/** Archives each pending change in directory order, then again the ones that failed, until a round archives nothing. */
function archiveAll(dir: string): { archived: string[]; failed: Array<{ change: string; output: string }> } {
  const archived: string[] = [];
  let pending = pendingChanges(dir);
  let last = new Map<string, string>();
  while (pending.length > 0) {
    const failed = new Map<string, string>();
    for (const change of pending) {
      const r = openspec(dir, ['archive', change, '--yes']);
      const moved = !existsSync(path.join(dir, 'openspec', 'changes', change));
      if (r.status === 0 && moved) archived.push(change);
      else failed.set(change, `${r.stdout ?? ''}${r.stderr ?? ''}`.trim());
    }
    last = failed;
    if (failed.size === pending.length) break;
    pending = [...failed.keys()];
  }
  return { archived, failed: [...last].map(([change, output]) => ({ change, output })) };
}

/** Requirement names of a capability, by index, as OpenSpec parses them. */
function requirementNames(dir: string, capability: string): string[] {
  const r = openspec(dir, ['show', capability, '--type', 'spec', '--json']);
  if (r.status !== 0) return [];
  try {
    const spec = JSON.parse(r.stdout) as { requirements?: Array<{ name?: string }> };
    return (spec.requirements ?? []).map((req) => req.name ?? '');
  } catch {
    return [];
  }
}

function describeIssue(names: string[], issue: Issue): string {
  const m = /^requirements\[(\d+)\]/.exec(issue.path ?? '');
  const where = m ? `requirement "${names[Number(m[1])] ?? `#${m[1]}`}" (${issue.path})` : issue.path || 'spec';
  return `${where}: ${issue.level} ${issue.message}`;
}

describe.skipIf(Boolean(reason))(reason ? `openspec --strict (skipped: ${reason})` : 'openspec --strict', () => {
  let tmp = '';

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'openspec-strict-'));
    cpSync(path.join(root, 'openspec'), path.join(tmp, 'openspec'), { recursive: true });
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('every pending change archives, and the specs it leaves validate with --strict', () => {
    const { failed } = archiveAll(tmp);
    expect(failed.map((f) => `change ${f.change} could not be archived:\n${f.output}`)).toEqual([]);

    const r = openspec(tmp, ['validate', '--specs', '--strict', '--json']);
    let items: Item[];
    try {
      items = (JSON.parse(r.stdout) as { items: Item[] }).items;
    } catch {
      throw new Error(`openspec validate --specs --strict --json printed no JSON (exit ${r.status}):\n${r.stdout}${r.stderr}`);
    }
    expect(items.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const item of items) {
      if (item.valid && item.issues.length === 0) continue;
      const names = requirementNames(tmp, item.id);
      if (item.issues.length === 0) problems.push(`${item.id}: invalid`);
      for (const issue of item.issues) problems.push(`${item.id}: ${describeIssue(names, issue)}`);
    }
    expect(problems).toEqual([]);
    expect(r.status).toBe(0);
  }, 300_000);
});
