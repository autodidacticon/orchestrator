import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConfigInput, defaultConfig } from '../../src/config.js';
import { DEFAULT_CLAUDE_COMMAND } from '../../src/runner/command.js';
import { ZodError } from 'zod';
import { applyOverridePatch, mergeOverrides, parseSetFlags, readOverrides, reportOf, resolveLayers } from '../../src/runs/resolve.js';
import { readConfigJson, writeConfigJson } from '../../src/runs/runDir.js';
import type { ToolchainRecord } from '../../src/toolchain/detect.js';
import { BASE_RULES } from '../../src/toolchain/tools.js';

const node: ToolchainRecord = { kinds: ['node'], manifests: ['package.json'], packageManager: 'npm', checkCommand: 'npm test', checkFrom: 'node', reasons: ['package.json has a test script: npm test'] };
const none: ToolchainRecord = { kinds: [], manifests: [], reasons: ['no recognised manifest in the repository root'] };
const npmRules = ['Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(npm exec:*)', 'Bash(node:*)', 'Bash(npm ci:*)', 'Bash(npx:*)'];
/** A repository whose orchestrator.yaml holds exactly `raw`. */
const file = (raw: ConfigInput) => ({ base: defaultConfig(raw), fileRaw: raw as Record<string, unknown> });

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// See specs/toolchain-discovery "Resolution order and provenance".
describe('layered resolution', () => {
  it('detection beats the default, the file beats detection, and the detection is still recorded', () => {
    const r = resolveLayers({ base: defaultConfig(), detected: { toolchain: node, integrationBranch: 'develop' } });
    expect(r.config.checkCommand).toBe('npm test');
    expect(r.provenance).toMatchObject({ checkCommand: 'detected', integrationBranch: 'detected', capacity: 'default', runnerCommand: 'default', allowedTools: 'composed' });
    expect(r.config.integrationBranch).toBe('develop');
    expect(r.needsConfig).toEqual([]);
    const f = resolveLayers({ ...file({ checkCommand: 'make check' }), detected: { toolchain: node } });
    expect(f.config.checkCommand).toBe('make check');
    expect(f.provenance.checkCommand).toBe('file');
    expect(f.toolchain).toBe(node);
    const d = resolveLayers({ base: defaultConfig(), detected: { toolchain: none, integrationBranch: undefined } });
    expect(d.config.integrationBranch).toBe('main');
    expect(d.provenance.integrationBranch).toBe('default');
  });

  it('an argument beats the file, and clearing it falls back to the next layer', () => {
    const inputs = { ...file({ capacity: 2 }), detected: { toolchain: node } };
    const a = resolveLayers(inputs, { capacity: 3, checkCommand: 'make check' });
    expect(a.config.capacity).toBe(3);
    expect(a.provenance.capacity).toBe('argument');
    expect(a.provenance.checkCommand).toBe('argument');
    expect(a.overrides).toEqual({ capacity: 3, checkCommand: 'make check' });
    const cleared = mergeOverrides({ capacity: 3, checkCommand: 'make check' }, { checkCommand: null });
    expect(cleared).toEqual({ capacity: 3 });
    const c = resolveLayers(inputs, cleared);
    expect(c.config.checkCommand).toBe('npm test');
    expect(c.provenance.checkCommand).toBe('detected');
    expect(resolveLayers(inputs).provenance.capacity).toBe('file');
    expect(mergeOverrides({}, { capacity: undefined, allowedTools: ['Bash(x:*)'] })).toEqual({ allowedTools: ['Bash(x:*)'] });
  });

  it('is unresolved when nothing supplies the check command, and npm test never appears', () => {
    const r = resolveLayers({ base: defaultConfig(), detected: { toolchain: none } });
    expect(r.config.checkCommand).toBeUndefined();
    expect(r.provenance.checkCommand).toBe('unresolved');
    expect(r.needsConfig).toEqual(['checkCommand']);
    expect(JSON.stringify(reportOf(r, 1))).not.toContain('npm test');
    expect(resolveLayers({ base: defaultConfig() }).needsConfig).toEqual(['checkCommand']);
    expect(resolveLayers({ ...file({}), detected: { toolchain: none } }).needsConfig).toEqual(['checkCommand']);
  });

  it('composes the allow list in layer order with each rule attributed to its layer', () => {
    const r = resolveLayers({ ...file({ runner: { claude: { allowedTools: ['Bash(docker:*)', 'Bash(git:*)'] } } }), detected: { toolchain: node } }, { allowedTools: ['Bash(make:*)', 'Bash(docker:*)'] });
    expect(r.allowedTools.value).toEqual([...BASE_RULES, ...npmRules, 'Bash(docker:*)', 'Bash(make:*)']);
    expect(r.allowedTools.parts).toEqual({ default: [...BASE_RULES], detected: npmRules, file: ['Bash(docker:*)'], argument: ['Bash(make:*)'] });
    expect(r.allowedTools.applied).toBe(true);
    expect(r.config.runnerCommand).toBe(DEFAULT_CLAUDE_COMMAND);
    const off = resolveLayers({ ...file({ runner: { claude: { deriveTools: false, allowedTools: ['Bash(make:*)'] } } }), detected: { toolchain: node } });
    expect(off.allowedTools.value).toEqual([...BASE_RULES, 'Bash(make:*)']);
    const report = reportOf(r, 7);
    expect(report.config.allowedTools).toMatchObject({ source: 'composed', applied: true, parts: { argument: ['Bash(make:*)'] } });
    expect(report.resolvedAt).toBe(7);
  });

  it('marks the list unapplied for a runner command without the slot', () => {
    const r = resolveLayers({ ...file({ runnerCommand: 'claude -p --allowedTools "Bash(git:*)" < {brief}' }), detected: { toolchain: node } });
    expect(r.allowedTools.applied).toBe(false);
    expect(r.provenance.runnerCommand).toBe('file');
    expect(resolveLayers({ base: defaultConfig() }, { runnerCommand: 'x {allowedTools}' })).toMatchObject({ allowedTools: { applied: true }, provenance: { runnerCommand: 'argument' } });
  });

  it('the pinned branch beats detection and the default and yields to the file and an argument', () => {
    const inputs = { base: defaultConfig(), detected: { toolchain: none, integrationBranch: 'develop' }, pinned: 'main' };
    expect(resolveLayers(inputs)).toMatchObject({ config: { integrationBranch: 'main' }, provenance: { integrationBranch: 'pinned' } });
    expect(resolveLayers({ ...inputs, detected: { toolchain: none } })).toMatchObject({ provenance: { integrationBranch: 'pinned' } });
    expect(resolveLayers({ ...file({ integrationBranch: 'release' }), detected: inputs.detected, pinned: 'main' })).toMatchObject({ config: { integrationBranch: 'release' }, provenance: { integrationBranch: 'file' } });
    expect(resolveLayers(inputs, { integrationBranch: 'trunk' })).toMatchObject({ config: { integrationBranch: 'trunk' }, provenance: { integrationBranch: 'argument' } });
  });

  it('config.json round-trips through write and read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-resolve-'));
    dirs.push(dir);
    const record = reportOf(resolveLayers({ base: defaultConfig({ repoPath: '/r' }), detected: { toolchain: node } }, { capacity: 3 }), 42);
    writeConfigJson(dir, record);
    expect(readConfigJson(dir)).toEqual(JSON.parse(JSON.stringify(record)));
    expect(readConfigJson(dir)?.config.capacity).toEqual({ value: 3, source: 'argument' });
    expect(readConfigJson(dir)?.config.model).toEqual({ value: 'claude-opus-5-5', source: 'default', applied: true });
    expect(readConfigJson(dir)?.config.effort).toEqual({ value: 'medium', source: 'default', applied: true });
    expect(readConfigJson(path.join(dir, 'nope'))).toBeUndefined();
  });

  // See specs/model-selection "Run default model and effort".
  it('model and effort default, take the file, take an argument, clear to the next layer, and report applied', () => {
    const d = resolveLayers({ base: defaultConfig(), detected: { toolchain: node } });
    expect(d.model).toEqual({ value: 'claude-opus-5-5', applied: true });
    expect(d.effort).toEqual({ value: 'medium', applied: true });
    expect(d.provenance).toMatchObject({ model: 'default', effort: 'default' });
    expect(d.config.runner.claude).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    const f = resolveLayers({ ...file({ runner: { claude: { model: 'opus' } } }), detected: { toolchain: node } }, { effort: 'high' });
    expect(f.model).toEqual({ value: 'opus', applied: true });
    expect(f.effort).toEqual({ value: 'high', applied: true });
    expect(f.provenance).toMatchObject({ model: 'file', effort: 'argument' });
    const a = resolveLayers({ base: defaultConfig(), detected: { toolchain: node } }, { model: 'claude-sonnet-5-5', effort: 'low' });
    expect(a.provenance).toMatchObject({ model: 'argument', effort: 'argument' });
    expect(a.config.runner.claude).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    const cleared = resolveLayers({ ...file({ runner: { claude: { model: 'opus' } } }) }, mergeOverrides({ model: 'claude-sonnet-5-5', effort: 'low' }, { model: null }));
    expect(cleared.model).toEqual({ value: 'opus', applied: true });
    expect(cleared.provenance).toMatchObject({ model: 'file', effort: 'argument' });
    const verbatim = resolveLayers({ ...file({ runnerCommand: 'claude -p {allowedTools} < {brief}' }) });
    expect(verbatim.model.applied).toBe(false);
    expect(verbatim.effort.applied).toBe(false);
    expect(verbatim.allowedTools.applied).toBe(true);
    const report = reportOf(a, 1);
    expect(report.config.model).toEqual({ value: 'claude-sonnet-5-5', source: 'argument', applied: true });
    expect(report.config.effort).toEqual({ value: 'low', source: 'argument', applied: true });
    expect(DEFAULT_CLAUDE_COMMAND).toContain('--model {model} --effort {effort}');
    expect(() => defaultConfig({ runner: { claude: { effort: 'huge' as never } } })).toThrow();
    expect(() => defaultConfig({ runner: { claude: { model: 'opus; rm' } } })).toThrow();
  });

  it('parses --set flags per key and refuses unknown keys, bad values, and unsafe rules', () => {
    expect(parseSetFlags(['capacity=3', 'checkCommand=make check', 'allowedTools=Bash(docker:*)', 'allowedTools=["Bash(make:*)"]', 'integrationBranch=develop'])).toEqual({
      capacity: 3,
      checkCommand: 'make check',
      allowedTools: ['Bash(docker:*)', 'Bash(make:*)'],
      integrationBranch: 'develop',
    });
    expect(parseSetFlags([])).toEqual({});
    expect(() => parseSetFlags(['nope=1'])).toThrow(/unknown key "nope"/);
    expect(() => parseSetFlags(['capacity=0'])).toThrow(/positive integer/);
    expect(() => parseSetFlags(['capacity'])).toThrow(/key=value/);
    expect(() => parseSetFlags(['allowedTools=Bash(echo "$HOME")'])).toThrow(/Bash\(echo/);
    expect(() => parseSetFlags(['allowedTools=[1]'])).toThrow(/JSON array/);
    expect(() => parseSetFlags(['checkCommand='])).toThrow(/non-empty/);
    expect(parseSetFlags(['model=claude-sonnet-5-5', 'effort=high'])).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(() => parseSetFlags(['effort=huge'])).toThrow(/^--set effort/);
    expect(() => parseSetFlags(['model=opus;rm'])).toThrow(/^--set model/);

    // Runner kinds: flat keys bind to the kind in the same patch, dotted keys fold into their namespace. See specs/worker-runners.
    const both = parseSetFlags(['runnerKind=codex', 'model=gpt-6-astra']);
    expect(both).toEqual({ runnerKind: 'codex', codex: { model: 'gpt-6-astra' } });
    const codexRun = resolveLayers({ base: defaultConfig() }, both);
    expect(codexRun.kind).toEqual({ value: 'codex', source: 'argument' });
    expect(reportOf(codexRun, 1).config.model).toEqual({ value: 'gpt-6-astra', source: 'argument', applied: true });
    const back = reportOf(resolveLayers({ base: defaultConfig() }, mergeOverrides(both, { runnerKind: null })), 1);
    expect(back.config.runnerKind).toEqual({ value: 'claude-code', source: 'default' });
    expect(back.config.model).toEqual({ value: 'claude-opus-5-5', source: 'default', applied: true });
    expect(back.config.codex.model).toEqual({ value: 'gpt-6-astra', source: 'argument' });
    expect(() => parseSetFlags(['runnerKind=cursor'])).toThrow(/^--set runnerKind/);
    expect(parseSetFlags(['codex.sandbox=read-only', 'codex.model=gpt-6-pro', 'claude.effort=high'])).toEqual({ codex: { sandbox: 'read-only', model: 'gpt-6-pro' }, claude: { effort: 'high' } });
    expect(parseSetFlags(['codex={"model":"gpt-6-pro"}'])).toEqual({ codex: { model: 'gpt-6-pro' } });
    expect(() => parseSetFlags(['codex.sandbox=open'])).toThrow(/^--set codex\.sandbox/);
    expect(() => parseSetFlags(['codex.nope=1'])).toThrow(/unknown key "codex.nope"/);
    expect(() => parseSetFlags(['effort=ultra'], 'claude-code')).toThrow(/^--set effort: .*claude-code/);
    expect(() => parseSetFlags(['runnerKind=claude-code', 'effort=ultra'])).toThrow(/^--set effort: .*claude-code/);
    expect(() => parseSetFlags(['claude.effort=ultra'])).toThrow(/^--set claude\.effort: .*claude-code/);
    expect(parseSetFlags(['effort=ultra'], 'codex')).toEqual({ codex: { effort: 'ultra' } });
    expect(parseSetFlags(['runnerKind=codex', 'effort=ultra'])).toEqual({ runnerKind: 'codex', codex: { effort: 'ultra' } });
  });
});

// See specs/worker-runners "Runner kinds and defaults" and "Per-kind effort sets".
describe('runner kinds', () => {
  it('defaults to claude-code and resolves codex defaults, file values, and no allow list under codex', () => {
    const d = reportOf(resolveLayers({ base: defaultConfig(), detected: { toolchain: node } }), 1);
    expect(d.config.runnerKind).toEqual({ value: 'claude-code', source: 'default' });
    expect(d.config.model).toEqual({ value: 'claude-opus-5-5', source: 'default', applied: true });
    expect(d.config.codex.model).toEqual({ value: 'gpt-6-astra', source: 'default' });
    const c = reportOf(resolveLayers({ ...file({ runner: { kind: 'codex' } }), detected: { toolchain: node } }), 1);
    expect(c.config.runnerKind).toEqual({ value: 'codex', source: 'file' });
    expect(c.config.model).toEqual({ value: 'gpt-6-astra', source: 'default', applied: true });
    expect(c.config.effort).toEqual({ value: 'medium', source: 'default', applied: true });
    expect(c.config.allowedTools).toEqual({ value: [], source: 'composed', parts: { default: [], detected: [], file: [], argument: [] }, applied: false });
    expect(c.config.codex).toMatchObject({ command: { value: undefined, source: 'default' }, sandbox: { value: 'workspace-write', source: 'default' }, ignoreUserConfig: { value: true, source: 'default' }, ephemeral: { value: true, source: 'default' } });
    const pro = reportOf(resolveLayers(file({ runner: { kind: 'codex', codex: { model: 'gpt-6-pro', sandbox: 'read-only', networkAccess: true } } })), 1);
    expect(pro.config.model).toEqual({ value: 'gpt-6-pro', source: 'file', applied: true });
    expect(pro.config.codex).toMatchObject({ sandbox: { value: 'read-only', source: 'file' }, networkAccess: { value: true, source: 'file' } });
    // A codex template from the file is read for the slots; the claude template no longer decides.
    const verbatim = resolveLayers(file({ runner: { kind: 'codex', codex: { command: 'codex exec -m {model} < {brief}' } } }));
    expect(verbatim.model.applied).toBe(true);
    expect(verbatim.effort.applied).toBe(false);
    expect(resolveLayers(file({ runnerCommand: 'claude -p < {brief}', runner: { kind: 'codex' } })).model.applied).toBe(true);
    // In memory, a kind other than the default stands for the file layer.
    expect(resolveLayers({ base: defaultConfig({ runner: { kind: 'codex' } }) }).kind).toEqual({ value: 'codex', source: 'file' });
  });

  // See specs/worker-runners "Sandbox and commit policy".
  it('derives runner.codex.commit from the sandbox and defaults runner.claude.commit to agent', () => {
    const commits = (r: ReturnType<typeof resolveLayers>) => ({ claude: r.config.runner.claude.commit, codex: r.config.runner.codex.commit });
    expect(commits(resolveLayers(file({})))).toEqual({ claude: 'agent', codex: 'daemon' });
    expect(commits(resolveLayers(file({ runner: { codex: { sandbox: 'danger-full-access' } } })))).toEqual({ claude: 'agent', codex: 'agent' });
    // The derivation follows a runtime sandbox override; an explicit commit wins over it, and claude.commit is overridable too.
    expect(resolveLayers(file({}), { codex: { sandbox: 'danger-full-access' } }).codex.commit).toEqual({ value: 'agent', source: 'default' });
    expect(resolveLayers(file({ runner: { codex: { sandbox: 'danger-full-access', commit: 'daemon' } } })).codex.commit).toEqual({ value: 'daemon', source: 'file' });
    expect(reportOf(resolveLayers(file({}), parseSetFlags(['claude.commit=daemon'])), 1).config.claude.commit).toEqual({ value: 'daemon', source: 'argument' });
  });

  it('validates the kind and the per-kind effort in the file', () => {
    let error: unknown;
    try {
      defaultConfig({ runner: { kind: 'cursor' as never } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues[0]?.path).toEqual(['runner', 'kind']);
    expect(() => defaultConfig({ runner: { claude: { effort: 'ultra' } } })).toThrow(/claude-code/);
    expect(defaultConfig({ runner: { codex: { effort: 'ultra' } } }).runner.codex.effort).toBe('ultra');
  });

  it('reads a stored flat model and effort as claude.* and clears one namespaced leaf with null', () => {
    const kv = (doc: unknown) => ({ getKv: (k: string) => (k === 'config.overrides' ? JSON.stringify(doc) : undefined) });
    const stored = readOverrides(kv({ model: 'opus', effort: 'high', capacity: 3 }));
    expect(stored).toEqual({ claude: { model: 'opus', effort: 'high' }, capacity: 3 });
    expect(reportOf(resolveLayers({ base: defaultConfig() }, stored), 1).config.model).toEqual({ value: 'opus', source: 'argument', applied: true });
    expect(readOverrides(kv({ model: 'opus', claude: { model: 'sonnet' } }))).toEqual({ claude: { model: 'sonnet' } });
    const doc = { runnerKind: 'codex' as const, codex: { model: 'gpt-6-pro', sandbox: 'read-only' as const }, claude: { model: 'opus' } };
    expect(mergeOverrides(doc, { codex: { model: null } })).toEqual({ runnerKind: 'codex', codex: { sandbox: 'read-only' }, claude: { model: 'opus' } });
    expect(mergeOverrides(doc, { codex: { model: null, sandbox: null } })).toEqual({ runnerKind: 'codex', claude: { model: 'opus' } });
    expect(mergeOverrides(doc, { codex: null })).toEqual({ runnerKind: 'codex', claude: { model: 'opus' } });
  });

  it('binds a patch to the kind in force when it is applied', () => {
    const inputs = { base: defaultConfig() };
    const toCodex = applyOverridePatch(inputs, { runnerKind: 'codex' }, { model: 'gpt-6-pro', effort: 'ultra' });
    expect(toCodex).toMatchObject({ ok: true, next: { runnerKind: 'codex', codex: { model: 'gpt-6-pro', effort: 'ultra' } } });
    expect(applyOverridePatch(inputs, {}, { effort: 'ultra' })).toMatchObject({ ok: false, key: 'effort', error: expect.stringContaining('claude-code') });
    expect(applyOverridePatch(inputs, { runnerKind: 'codex' }, { codex: null, model: 'gpt-6-pro' })).toMatchObject({ ok: false, key: 'codex' });
    // Clearing the kind in the same patch binds the flat keys to the kind it falls back to.
    expect(applyOverridePatch({ base: defaultConfig({ runner: { kind: 'codex' } }) }, { runnerKind: 'claude-code' }, { runnerKind: null, effort: 'ultra' })).toMatchObject({ ok: true, next: { codex: { effort: 'ultra' } } });
  });
});
