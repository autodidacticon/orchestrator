import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string>; devDependencies: Record<string, string> };

/** Instructions of the Dockerfile with comments dropped and continuations joined, split into stages at FROM. */
function stages(text: string): Array<{ from: string; body: string }> {
  const lines = text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const out: Array<{ from: string; body: string }> = [];
  for (const line of lines) {
    const from = /^FROM\s+(.*)$/i.exec(line);
    if (from) out.push({ from: from[1] as string, body: '' });
    else if (out.length) (out[out.length - 1] as { body: string }).body += `${line}\n`;
  }
  return out;
}

describe('daemon image', () => {
  const dockerfile = stages(read('Dockerfile'));
  const final = dockerfile[dockerfile.length - 1] as { from: string; body: string };

  it('is multi-stage on node:22-slim', () => {
    expect(dockerfile.length).toBeGreaterThanOrEqual(2);
    for (const s of dockerfile) expect(s.from.split(/\s+/)[0]).toBe('node:22-slim');
    expect(dockerfile[0]?.body).toMatch(/npm ci\b/);
    expect(dockerfile[0]?.body).toMatch(/npm run build/);
  });

  it('final stage installs git and openssh-client and nothing that is a toolchain', () => {
    const installs = [...final.body.matchAll(/apt-get install([^&\n]*)/g)];
    expect(installs).toHaveLength(1);
    const packages = (installs[0]?.[1] ?? '').split(/\s+/).filter((w) => w && !w.startsWith('-'));
    expect(packages).toEqual(expect.arrayContaining(['git', 'openssh-client']));
    for (const p of packages) expect(['git', 'openssh-client', 'ca-certificates']).toContain(p);
  });

  it('final stage carries the built dist and production dependencies only', () => {
    expect(final.body).toMatch(/npm ci --omit=dev/);
    expect(final.body).toMatch(/COPY --from=\S+ \S*dist\/src/);
    expect(final.body).not.toMatch(/\bCOPY\s+(\.\/)?src\b/);
    for (const dev of Object.keys(pkg.devDependencies)) expect(final.body).not.toContain(` ${dev}`);
  });

  it('puts orchestrator and orchestrator-ctl on PATH from the package bins', () => {
    for (const name of ['orchestrator', 'orchestrator-ctl']) {
      const target = (pkg.bin[name] as string).replace(/^\.\//, '');
      expect(final.body).toMatch(new RegExp(`ln -s \\S*${target.replace(/[.]/g, '\\.')} /usr/local/bin/${name}(\\s|$)`));
    }
    expect(final.body).not.toMatch(/^ENTRYPOINT/m);
  });

  it('.dockerignore keeps local state and fixtures out of the context', () => {
    const ignored = read('.dockerignore').split('\n').map((l) => l.trim());
    expect(ignored).toEqual(expect.arrayContaining(['node_modules', 'dist', '.git', '.orchestrator-run', 'test/fixtures']));
  });

  it('deploy/README.md names the image, the build command, and both entrypoints', () => {
    const readme = read('deploy/README.md');
    expect(readme).toContain('orchestrator:dev');
    expect(readme).toContain('docker build -t orchestrator:dev .');
    expect(readme).toContain('`orchestrator`');
    expect(readme).toContain('`orchestrator-ctl`');
  });
});
