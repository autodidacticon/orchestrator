/**
 * Real workspace over git worktrees. See specs/integration-pipeline "Repository layout".
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { composeBrief } from '../brief/compose.js';
import type { Id } from '../graph/model.js';
import type { Launch } from '../state/store.js';
import { existsSync } from 'node:fs';
import { dirtyFiles, git, refExists, revParse, tagIdempotent, worktreeAdd, worktreeList, worktreeRemove } from './git.js';
import type { BriefInput, FallbackReport, SealResult, Workspace } from './workspace.js';

export const ORCH_DIR = '.orchestrator';
export const FALLBACK_FILE = 'report.json';

export class GitWorkspace implements Workspace {
  constructor(
    public readonly repo: string,
    public readonly integrationBranch: string,
    public readonly worktreesRoot: string,
  ) {}

  async integrationHead(): Promise<string> {
    return revParse(this.repo, this.integrationBranch);
  }

  async prepare(launch: Launch, brief: BriefInput): Promise<void> {
    await mkdir(path.dirname(launch.worktree), { recursive: true });
    if (await refExists(this.repo, `refs/heads/${launch.branch}`)) {
      // Re-preparing a launch whose worktree vanished: reset its branch to the base and attach a new worktree.
      await git(this.repo, ['worktree', 'prune'], { allowFail: true });
      await git(this.repo, ['branch', '-f', launch.branch, launch.baseSha]);
      await git(this.repo, ['worktree', 'add', launch.worktree, launch.branch]);
    } else {
      await worktreeAdd(this.repo, launch.worktree, launch.branch, launch.baseSha);
    }
    await this.ensureExcluded();
    const dir = path.join(launch.worktree, ORCH_DIR);
    await mkdir(dir, { recursive: true });
    const { markdown, json } = composeBrief(brief, { fallbackPath: path.join(dir, FALLBACK_FILE) });
    await writeFile(path.join(dir, 'brief.md'), markdown, 'utf8');
    await writeFile(path.join(dir, 'brief.json'), JSON.stringify(json, null, 2), 'utf8');
  }

  /** info/exclude lives in the common git dir and is shared by all worktrees. Idempotent. */
  private async ensureExcluded(): Promise<void> {
    const common = (await git(this.repo, ['rev-parse', '--git-common-dir'])).stdout.trim();
    const absCommon = path.isAbsolute(common) ? common : path.join(this.repo, common);
    const file = path.join(absCommon, 'info', 'exclude');
    await mkdir(path.dirname(file), { recursive: true });
    const current = await readFile(file, 'utf8').catch(() => '');
    const line = `${ORCH_DIR}/`;
    if (!current.split('\n').some((l) => l.trim() === line)) {
      await writeFile(file, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`, 'utf8');
    }
  }

  async seal(launch: Launch): Promise<SealResult> {
    const dirty = (await dirtyFiles(launch.worktree)).filter((f) => !f.startsWith(`${ORCH_DIR}/`));
    if (dirty.length) return { ok: false, dirty };
    return { ok: true, sealedSha: await revParse(launch.worktree, 'HEAD') };
  }

  async readFallback(launch: Launch): Promise<FallbackReport | undefined> {
    const p = path.join(launch.worktree, ORCH_DIR, FALLBACK_FILE);
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch {
      return undefined;
    }
    await rm(p, { force: true });
    try {
      const parsed = JSON.parse(text) as Partial<FallbackReport>;
      if (!parsed || typeof parsed !== 'object' || !parsed.kind) return undefined;
      return {
        launchId: String(parsed.launchId ?? launch.launchId),
        seq: Number(parsed.seq ?? 0),
        kind: parsed.kind,
        body: (parsed.body ?? {}) as Record<string, unknown>,
      };
    } catch {
      return undefined;
    }
  }

  async remove(launch: Launch): Promise<void> {
    await worktreeRemove(this.repo, launch.worktree);
    await rm(launch.worktree, { recursive: true, force: true });
  }

  async listWorktrees(): Promise<string[]> {
    const root = await realpath(path.resolve(this.worktreesRoot)).catch(() => path.resolve(this.worktreesRoot));
    const all = await worktreeList(this.repo);
    const out: string[] = [];
    for (const p of all) {
      const real = await realpath(p).catch(() => path.resolve(p));
      if (real.startsWith(`${root}${path.sep}`)) out.push(path.basename(real));
    }
    return out;
  }

  async tagMilestone(id: Id, version: number, sha: string): Promise<void> {
    await tagIdempotent(this.repo, `milestone/${id}/v${version}`, sha);
  }

  async diffStat(from: string, to: string): Promise<string> {
    const r = await git(this.repo, ['diff', '--stat', `${from}..${to}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : '';
  }

  async exists(launch: Launch): Promise<boolean> {
    return existsSync(path.join(launch.worktree, ORCH_DIR, 'brief.json'));
  }

  /** Head sha plus a hash over `git status --porcelain` (minus .orchestrator/) and `git diff HEAD`, so edits to an already dirty file still register. */
  async fingerprint(launch: Launch): Promise<string> {
    const head = await revParse(launch.worktree, 'HEAD');
    const status = await git(launch.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFail: true });
    const entries = status.stdout.split('\0').filter((e) => e && !e.slice(3).startsWith(`${ORCH_DIR}/`));
    const diff = await git(launch.worktree, ['diff', 'HEAD', '--', '.', `:(exclude)${ORCH_DIR}`], { allowFail: true });
    const hash = createHash('sha256').update(entries.join('\0')).update('\n').update(diff.stdout).digest('hex').slice(0, 16);
    return `${head}:${hash}`;
  }
}
