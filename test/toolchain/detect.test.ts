import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectToolchain, type ToolchainKind } from '../../src/toolchain/detect.js';
import { BASE_RULES, composeAllowedTools, isSafeRule, rulesFor } from '../../src/toolchain/tools.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/toolchains');
const at = (name: string) => path.join(fixtures, name);

export const npmRules = ['Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(npm exec:*)', 'Bash(node:*)', 'Bash(npm ci:*)', 'Bash(npx:*)'];

// See specs/toolchain-discovery "Toolchain detection" and "Node package manager selection".
const table: Array<[fixture: string, checkCommand: string | undefined, kinds: ToolchainKind[], packageManager: string | undefined]> = [
  ['node-npm', 'npm test', ['node'], 'npm'],
  ['node-pnpm', 'pnpm test', ['node'], 'pnpm'],
  ['node-yarn', 'yarn test', ['node'], 'yarn'],
  ['node-bun', 'bun test', ['node'], 'bun'],
  ['node-packagemanager-field', 'yarn test', ['node'], 'yarn'],
  ['node-placeholder', undefined, ['node'], 'npm'],
  ['rust', 'cargo test', ['rust'], undefined],
  ['go', 'go test ./...', ['go'], undefined],
  ['python-plain', 'pytest', ['python'], undefined],
  ['python-uv', 'uv run pytest', ['python'], undefined],
  ['python-poetry', 'poetry run pytest', ['python'], undefined],
  ['ruby-rake', 'bundle exec rake test', ['ruby'], undefined],
  ['ruby-rspec', 'bundle exec rspec', ['ruby'], undefined],
  ['gradle-wrapper', './gradlew test', ['gradle'], undefined],
  ['gradle-plain', 'gradle test', ['gradle'], undefined],
  ['maven', 'mvn -q test', ['maven'], undefined],
  ['elixir', 'mix test', ['elixir'], undefined],
  ['dotnet', 'dotnet test', ['dotnet'], undefined],
  ['make-only', 'make test', ['make'], undefined],
  ['make-no-test', 'go test ./...', ['make', 'go'], undefined],
  ['polyglot', 'make test', ['make', 'node', 'go'], 'npm'],
  ['nested-only', undefined, [], undefined],
  ['empty', undefined, [], undefined],
];

describe('toolchain detection', () => {
  it.each(table)('%s', async (fixture, checkCommand, kinds, packageManager) => {
    const r = await detectToolchain(at(fixture));
    expect(r.checkCommand).toBe(checkCommand);
    expect(r.kinds).toEqual(kinds);
    expect(r.packageManager).toBe(packageManager);
    expect(r.manifests).toHaveLength(kinds.length);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('records why: the lockfile, the placeholder, the Makefile target, and the subdirectory that is ignored', async () => {
    expect((await detectToolchain(at('node-pnpm'))).reasons.join('\n')).toContain('pnpm-lock.yaml');
    const placeholder = await detectToolchain(at('node-placeholder'));
    expect(placeholder.reasons.join('\n')).toMatch(/placeholder/);
    expect(placeholder.checkFrom).toBeUndefined();
    const polyglot = await detectToolchain(at('polyglot'));
    expect(polyglot.checkFrom).toBe('make');
    expect(polyglot.manifests).toEqual(['Makefile', 'package.json', 'go.mod']);
    const nested = await detectToolchain(at('nested-only'));
    expect(nested).toMatchObject({ kinds: [], manifests: [] });
    expect(nested.checkCommand).toBeUndefined();
    expect(nested.reasons.join('\n')).toContain('no recognised manifest');
    expect((await detectToolchain(at('python-uv'))).python).toBe('uv');
    expect((await detectToolchain(at('does-not-exist'))).kinds).toEqual([]);
  });
});

describe('derived allowed tools', () => {
  it('derives the exact Node list, every toolchain of a polyglot root, and the Python runner rule', async () => {
    expect(rulesFor(await detectToolchain(at('node-npm')))).toEqual(npmRules);
    expect(rulesFor(await detectToolchain(at('node-pnpm')))).toEqual(['Bash(pnpm test:*)', 'Bash(pnpm run:*)', 'Bash(pnpm install:*)', 'Bash(pnpm exec:*)', 'Bash(node:*)', 'Bash(npx:*)']);
    expect(rulesFor(await detectToolchain(at('node-bun')))).toContain('Bash(bunx:*)');
    const polyglot = rulesFor(await detectToolchain(at('polyglot')));
    expect(polyglot).toEqual(expect.arrayContaining(['Bash(make:*)', 'Bash(go:*)', ...npmRules]));
    expect(polyglot[0]).toBe('Bash(make:*)');
    expect(rulesFor(await detectToolchain(at('python-uv')))).toEqual(['Bash(pytest:*)', 'Bash(python:*)', 'Bash(python3:*)', 'Bash(pip:*)', 'Bash(uv:*)']);
    expect(rulesFor(await detectToolchain(at('python-poetry')))).toContain('Bash(poetry:*)');
    expect(rulesFor(await detectToolchain(at('empty')))).toEqual([]);
    expect(rulesFor(undefined)).toEqual([]);
  });

  it('composes base, detected, file, and argument rules in order, drops duplicates, and keeps base plus added rules without derivation', async () => {
    const record = await detectToolchain(at('node-npm'));
    const on = composeAllowedTools({ record, deriveTools: true, fileRules: ['Bash(docker:*)', 'Bash(git:*)'], argumentRules: ['Bash(make:*)', 'Bash(docker:*)'] });
    expect(on.value).toEqual([...BASE_RULES, ...npmRules, 'Bash(docker:*)', 'Bash(make:*)']);
    expect(on.parts).toEqual({ default: [...BASE_RULES], detected: npmRules, file: ['Bash(docker:*)'], argument: ['Bash(make:*)'] });
    const off = composeAllowedTools({ record, deriveTools: false, fileRules: ['Bash(make:*)'], argumentRules: [] });
    expect(off.value).toEqual([...BASE_RULES, 'Bash(make:*)']);
    expect(off.value.some((r) => r.includes('npm'))).toBe(false);
  });

  it('rejects rules that would break out of the quoted command line', () => {
    expect(isSafeRule('Bash(docker:*)')).toBe(true);
    expect(isSafeRule('mcp__orchestrator__log')).toBe(true);
    expect(isSafeRule('Bash(echo "$HOME")')).toBe(false);
    expect(isSafeRule('Bash(echo `id`)')).toBe(false);
    expect(isSafeRule('Bash(a\\b)')).toBe(false);
    expect(isSafeRule('')).toBe(false);
  });
});
