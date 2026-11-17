import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConfigInput, defaultConfig } from '../../src/config.js';
import { DEFAULT_CLAUDE_COMMAND } from '../../src/runner/command.js';
import { ZodError } from 'zod';
import { applyOverridePatch, foldRunnerArgs, mergeOverrides, parseSetFlags, readOverrides, reportOf, resolveLayers } from '../../src/runs/resolve.js';
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

// See specs/worker-runners "Runner kinds and defaults" and specs/operator-control "Configuration route".
describe('the opencode namespace', () => {
  it('resolves the file kind with its defaults, folds the dotted keys, binds a flat provider/model, and refuses one under another kind', () => {
    const o = reportOf(resolveLayers(file({ runner: { kind: 'opencode' } })), 1);
    expect(o.config.runnerKind).toEqual({ value: 'opencode', source: 'file' });
    expect(o.config.model).toEqual({ value: 'anthropic/claude-opus-5-5', source: 'default', applied: true });
    expect(o.config.opencode).toMatchObject({ model: { value: 'anthropic/claude-opus-5-5', source: 'default' }, commit: { value: 'agent', source: 'default' }, permission: { value: 'derived', source: 'default' }, dataDir: { value: 'shared', source: 'default' } });
    expect(o.config.allowedTools.applied).toBe(false);
    const set = parseSetFlags(['opencode.model=opencode/big-pickle', 'opencode.dataDir=launch']);
    expect(set).toEqual({ opencode: { model: 'opencode/big-pickle', dataDir: 'launch' } });
    const r = resolveLayers(file({ runner: { kind: 'opencode' } }), set);
    expect(r.config.runner.opencode).toMatchObject({ model: 'opencode/big-pickle', dataDir: 'launch', permission: 'derived' });
    expect(reportOf(r, 1).config.opencode.dataDir).toEqual({ value: 'launch', source: 'argument' });
    expect(parseSetFlags(['model=ollama/qwen3.6:35b-mlx'], 'opencode')).toEqual({ opencode: { model: 'ollama/qwen3.6:35b-mlx' } });
    expect(() => parseSetFlags(['model=opencode/big-pickle'], 'claude-code')).toThrow(/^--set model/);
    expect(() => parseSetFlags(['opencode.model=big-pickle'])).toThrow(/^--set opencode\.model: .*provider\/model/);
    expect(() => parseSetFlags(['opencode.effort=ultra'])).toThrow(/^--set opencode\.effort: .*opencode/);
    expect(() => parseSetFlags(['opencode.permission=ask'])).toThrow(/^--set opencode\.permission/);
    // Not a namespaced leaf: the file-only policies.
    expect(() => parseSetFlags(['opencode.pure=false'])).toThrow(/unknown key "opencode.pure"/);
    // An unbound flat provider/model does not reach a claude-code run.
    expect(reportOf(resolveLayers({ base: defaultConfig() }, { model: 'opencode/big-pickle' }), 1).config.model).toEqual({ value: 'claude-opus-5-5', source: 'default', applied: true });
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

// See specs/worker-runners "Codex network access override".
describe('codex.networkAccess override', () => {
  it('resolves an argument over the file, and an override of false is an argument', () => {
    const set = resolveLayers(file({}), { codex: { networkAccess: true } });
    expect(set.codex.networkAccess).toEqual({ value: true, source: 'argument' });
    expect(set.config.runner.codex.networkAccess).toBe(true);
    const filed = file({ runner: { codex: { networkAccess: true } } });
    const off = resolveLayers(filed, { codex: { networkAccess: false } });
    expect(off.codex.networkAccess).toEqual({ value: false, source: 'argument' });
    expect(off.config.runner.codex.networkAccess).toBe(false);
    expect(resolveLayers(filed).codex.networkAccess).toEqual({ value: true, source: 'file' });
    expect(resolveLayers(file({})).codex.networkAccess).toEqual({ value: undefined, source: 'default' });
  });

  it('parses --set codex.networkAccess as exactly true or false, and keeps the JSON-object form', () => {
    expect(parseSetFlags(['codex.networkAccess=true'])).toEqual({ codex: { networkAccess: true } });
    expect(parseSetFlags(['codex.networkAccess=false'])).toEqual({ codex: { networkAccess: false } });
    expect(parseSetFlags(['codex={"networkAccess":true}'])).toEqual({ codex: { networkAccess: true } });
    expect(parseSetFlags(['codex.sandbox=read-only', 'codex.networkAccess=false'])).toEqual({ codex: { sandbox: 'read-only', networkAccess: false } });
    for (const bad of ['codex.networkAccess=', 'codex.networkAccess=1', 'codex.networkAccess=yes', 'codex.networkAccess=True']) expect(() => parseSetFlags([bad]), bad).toThrow(/^--set codex\.networkAccess/);
    expect(() => parseSetFlags(['codex={"networkAccess":"true"}'])).toThrow(/codex\.networkAccess/);
  });

  it('merges and clears only its own leaf', () => {
    expect(mergeOverrides({ codex: { sandbox: 'read-only', networkAccess: true } }, { codex: { networkAccess: null } })).toEqual({ codex: { sandbox: 'read-only' } });
    expect(mergeOverrides({ codex: { networkAccess: true } }, { codex: { networkAccess: false } })).toEqual({ codex: { networkAccess: false } });
  });

  it('folds the flat tool argument under codex whatever the kind, and refuses a clear and a set in one call', () => {
    expect(foldRunnerArgs({ networkAccess: false }, 'claude-code')).toEqual({ codex: { networkAccess: false } });
    expect(foldRunnerArgs({ networkAccess: null }, 'codex')).toEqual({ codex: { networkAccess: null } });
    expect(() => foldRunnerArgs({ codex: null, networkAccess: true }, 'codex')).toThrow(/codex is cleared/);
    expect(() => foldRunnerArgs({ codex: { networkAccess: null }, networkAccess: true }, 'codex')).toThrow(/both cleared and set/);
  });

  it('a stored document keeps the leaf through readOverrides', () => {
    const kv = (doc: unknown) => ({ getKv: (k: string) => (k === 'config.overrides' ? JSON.stringify(doc) : undefined) });
    expect(readOverrides(kv({ codex: { networkAccess: false } }))).toEqual({ codex: { networkAccess: false } });
  });
});

// See specs/toolchain-discovery "Runtime limit overrides" and "Limit leaves in the resolved configuration record".
describe('limit overrides', () => {
  it('reads the sources from the file nested blocks, and an override of 0 is an argument', () => {
    const r = reportOf(resolveLayers(file({ health: { stuckFailAfterMs: 1_800_000 } })), 1);
    expect(r.config.health).toEqual({ stuckFailAfterMs: { value: 1_800_000, source: 'file' }, stuckAfterMs: { value: 900_000, source: 'default' } });
    expect(r.config.budgets).toEqual({ maxLaunchMs: { value: 7_200_000, source: 'default' } });
    const zero = resolveLayers(file({ health: { stuckFailAfterMs: 1_800_000 }, budgets: { maxLaunchMs: 600_000 } }), { health: { stuckFailAfterMs: 0 }, budgets: { maxLaunchMs: 0 } });
    expect(zero.health.stuckFailAfterMs).toEqual({ value: 0, source: 'argument' });
    expect(zero.budgets.maxLaunchMs).toEqual({ value: 0, source: 'argument' });
    expect(zero.config.health).toMatchObject({ stuckFailAfterMs: 0, stuckAfterMs: 900_000, reportGraceMs: 30_000 });
    expect(zero.config.budgets).toMatchObject({ maxLaunchMs: 0, maxRunCostUsd: 0 });
    expect(resolveLayers(file({ budgets: { maxLaunchMs: 600_000 } })).budgets.maxLaunchMs).toEqual({ value: 600_000, source: 'file' });
  });

  it('parses the dotted limit keys as decimal digits only, and keeps the JSON-object form', () => {
    expect(parseSetFlags(['health.stuckAfterMs=0'])).toEqual({ health: { stuckAfterMs: 0 } });
    expect(parseSetFlags(['health.stuckAfterMs=1', 'health.stuckFailAfterMs=2'])).toEqual({ health: { stuckAfterMs: 1, stuckFailAfterMs: 2 } });
    expect(parseSetFlags(['budgets.maxLaunchMs=10800000'])).toEqual({ budgets: { maxLaunchMs: 10_800_000 } });
    expect(parseSetFlags([`budgets.maxLaunchMs=${Number.MAX_SAFE_INTEGER}`])).toEqual({ budgets: { maxLaunchMs: Number.MAX_SAFE_INTEGER } });
    for (const raw of ['', 'abc', '1.5', '-1', '1e3', '0x10', ' 5', String(2 ** 53), '99999999999999999999']) {
      expect(() => parseSetFlags([`budgets.maxLaunchMs=${raw}`]), raw).toThrow(/^--set budgets\.maxLaunchMs expects milliseconds as decimal digits/);
    }
    // The spawn path passes a block as a JSON object, a null leaf included.
    expect(parseSetFlags(['health={"stuckAfterMs":0,"stuckFailAfterMs":null}'])).toEqual({ health: { stuckAfterMs: 0, stuckFailAfterMs: null } });
    expect(() => parseSetFlags(['health={"stuckAfterMs":-1}'])).toThrow(/^--set health\.stuckAfterMs/);
    expect(() => parseSetFlags(['health.reportGraceMs=1'])).toThrow(/unknown key "health.reportGraceMs".*health\.stuckFailAfterMs/);
    expect(() => parseSetFlags(['budgets.maxRunCostUsd=1'])).toThrow(/unknown key "budgets.maxRunCostUsd"/);
    expect(() => parseSetFlags(['health=5'])).toThrow(/health\.stuckAfterMs, health\.stuckFailAfterMs/);
  });

  it('refuses a bad value naming the dotted key, and merges and clears leaves', () => {
    const inputs = { base: defaultConfig() };
    for (const v of [-1, 1.5, '5000', Number.MAX_SAFE_INTEGER + 2]) {
      expect(applyOverridePatch(inputs, {}, { budgets: { maxLaunchMs: v } }), String(v)).toMatchObject({ ok: false, key: 'budgets.maxLaunchMs' });
    }
    expect(applyOverridePatch(inputs, {}, { health: { reportGraceMs: 1 } })).toMatchObject({ ok: false, key: 'health.reportGraceMs' });
    const doc = { health: { stuckAfterMs: 300_000, stuckFailAfterMs: 600_000 }, budgets: { maxLaunchMs: 1 } };
    expect(mergeOverrides(doc, { health: { stuckAfterMs: null } })).toEqual({ health: { stuckFailAfterMs: 600_000 }, budgets: { maxLaunchMs: 1 } });
    expect(mergeOverrides(doc, { health: null, budgets: { maxLaunchMs: null } })).toEqual({});
    expect(readOverrides({ getKv: () => JSON.stringify(doc) })).toEqual(doc);
  });

  it('applies the pair rule to a patch that touches a stuck limit, naming both keys, values and sources', () => {
    const inputs = file({ health: { stuckAfterMs: 900_000, stuckFailAfterMs: 2_700_000 } });
    const lower = applyOverridePatch(inputs, {}, { health: { stuckFailAfterMs: 600_000 } });
    expect(lower).toMatchObject({ ok: false, key: 'health.stuckFailAfterMs' });
    expect((lower as { error: string }).error).toMatch(/600000[\s\S]*900000/);
    expect(applyOverridePatch(inputs, {}, { health: { stuckAfterMs: 3_000_000 } })).toMatchObject({ ok: false, key: 'health.stuckAfterMs' });
    // Equal values are refused too.
    expect(applyOverridePatch(inputs, {}, { health: { stuckAfterMs: 2_700_000 } })).toMatchObject({ ok: false, key: 'health.stuckAfterMs' });
    expect(applyOverridePatch(inputs, {}, { health: { stuckAfterMs: 300_000, stuckFailAfterMs: 600_000 } })).toMatchObject({ ok: true, next: { health: { stuckAfterMs: 300_000, stuckFailAfterMs: 600_000 } } });
    expect(applyOverridePatch(inputs, {}, { health: { stuckAfterMs: 0, stuckFailAfterMs: 600_000 } })).toMatchObject({ ok: true });
    expect(applyOverridePatch(inputs, {}, { health: { stuckAfterMs: 900_000, stuckFailAfterMs: 0 } })).toMatchObject({ ok: true });
    expect(applyOverridePatch(inputs, {}, { health: { stuckAfterMs: null, stuckFailAfterMs: null } })).toMatchObject({ ok: true, next: {} });
    // Over stored overrides, a null leaf that brings back the file value is refused.
    const stored = { health: { stuckAfterMs: 300_000, stuckFailAfterMs: 600_000 } };
    const back = applyOverridePatch(inputs, stored, { health: { stuckAfterMs: null } });
    expect(back).toMatchObject({ ok: false, key: 'health.stuckAfterMs' });
    const msg = (back as { error: string }).error;
    for (const word of ['health.stuckAfterMs 900000 (file)', 'health.stuckFailAfterMs 600000 (argument)']) expect(msg, word).toContain(word);
    // A null block counts as touching the pair.
    expect(applyOverridePatch(file({ health: { stuckAfterMs: 3_000_000 } }), stored, { health: null })).toMatchObject({ ok: false, key: 'health.stuckFailAfterMs' });
    expect(applyOverridePatch({ base: defaultConfig() }, stored, { health: null })).toMatchObject({ ok: true, next: {} });
  });

  it('skips the pair rule for a patch that touches neither stuck limit', () => {
    const broken = file({ health: { stuckFailAfterMs: 600_000 } });
    expect(applyOverridePatch(broken, {}, {})).toMatchObject({ ok: true, next: {} });
    expect(applyOverridePatch(broken, {}, { capacity: 3 })).toMatchObject({ ok: true, next: { capacity: 3 } });
    expect(applyOverridePatch(broken, {}, { budgets: { maxLaunchMs: 1 } })).toMatchObject({ ok: true });
    expect(applyOverridePatch(broken, {}, { health: {} })).toMatchObject({ ok: true });
    expect(applyOverridePatch(broken, {}, { health: { stuckAfterMs: 1 } })).toMatchObject({ ok: true });
  });
});
