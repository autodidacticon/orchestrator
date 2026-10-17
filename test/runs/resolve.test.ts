import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConfigInput, defaultConfig } from '../../src/config.js';
import { DEFAULT_CLAUDE_COMMAND } from '../../src/runner/command.js';
import { mergeOverrides, parseSetFlags, reportOf, resolveLayers } from '../../src/runs/resolve.js';
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
  });
});
