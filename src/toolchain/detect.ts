/**
 * Toolchain detection from the repository root, against a fixed table in a
 * fixed order; the first row with a command supplies the check command, every
 * row whose manifest is present is recorded as found. Reads the root only,
 * never subdirectories, and runs no commands. See specs/toolchain-discovery
 * "Toolchain detection" and "Node package manager selection".
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type ToolchainKind = 'make' | 'node' | 'rust' | 'go' | 'python' | 'ruby' | 'gradle' | 'maven' | 'elixir' | 'dotnet';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type PythonRunner = 'uv' | 'poetry' | 'pip';

export interface ToolchainRecord {
  /** Toolchains found, in table order. */
  kinds: ToolchainKind[];
  /** The manifest files that matched, in table order. */
  manifests: string[];
  packageManager?: PackageManager;
  python?: PythonRunner;
  checkCommand?: string;
  /** The toolchain that supplied the check command. */
  checkFrom?: ToolchainKind;
  /** One line per decision. */
  reasons: string[];
}

const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export async function detectToolchain(repoRoot: string): Promise<ToolchainRecord> {
  let names: string[] = [];
  try {
    names = await readdir(repoRoot);
  } catch {
    return { kinds: [], manifests: [], reasons: [`${repoRoot} could not be read`] };
  }
  const has = (n: string) => names.includes(n);
  const record: ToolchainRecord = { kinds: [], manifests: [], reasons: [] };
  const found = (kind: ToolchainKind, manifest: string, command: string | undefined, reason: string) => {
    record.kinds.push(kind);
    record.manifests.push(manifest);
    record.reasons.push(reason);
    if (command && record.checkCommand === undefined) {
      record.checkCommand = command;
      record.checkFrom = kind;
    }
  };

  // 1. make: a root test target is the repository's own declaration of how it is checked.
  const makefile = ['Makefile', 'GNUmakefile', 'makefile'].find(has);
  if (makefile) {
    let hasTest = false;
    try {
      hasTest = /^test\s*:/m.test(await readFile(path.join(repoRoot, makefile), 'utf8'));
    } catch {
      /* unreadable: no target */
    }
    found('make', makefile, hasTest ? 'make test' : undefined, hasTest ? `${makefile} defines a test target: make test` : `${makefile} has no test target`);
  }

  // 2. node
  if (has('package.json')) {
    let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown } | undefined;
    try {
      pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as typeof pkg;
    } catch {
      pkg = undefined;
    }
    const field = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
    let pm: PackageManager;
    let why: string;
    if (field === 'npm' || field === 'pnpm' || field === 'yarn' || field === 'bun') {
      pm = field;
      why = `package.json names ${field} in packageManager`;
    } else if (has('pnpm-lock.yaml')) {
      pm = 'pnpm';
      why = 'pnpm-lock.yaml selects pnpm';
    } else if (has('yarn.lock')) {
      pm = 'yarn';
      why = 'yarn.lock selects yarn';
    } else if (has('bun.lock') || has('bun.lockb')) {
      pm = 'bun';
      why = `${has('bun.lock') ? 'bun.lock' : 'bun.lockb'} selects bun`;
    } else {
      pm = 'npm';
      why = 'no lockfile or packageManager field: npm';
    }
    record.packageManager = pm;
    const script = typeof pkg?.scripts?.['test'] === 'string' ? pkg.scripts['test'] : '';
    const real = script.trim() !== '' && squash(script) !== squash(NPM_PLACEHOLDER);
    found(
      'node',
      'package.json',
      real ? `${pm} test` : undefined,
      real ? `package.json has a test script: ${pm} test (${why})` : script.trim() === '' ? `package.json has no test script (${why})` : `package.json's test script is npm's placeholder, not a test (${why})`,
    );
  }

  if (has('Cargo.toml')) found('rust', 'Cargo.toml', 'cargo test', 'Cargo.toml: cargo test');
  if (has('go.mod')) found('go', 'go.mod', 'go test ./...', 'go.mod: go test ./...');

  const pyManifest = ['pyproject.toml', 'setup.cfg', 'pytest.ini'].find(has);
  if (pyManifest) {
    const runner: PythonRunner = has('uv.lock') ? 'uv' : has('poetry.lock') ? 'poetry' : 'pip';
    record.python = runner;
    const cmd = runner === 'uv' ? 'uv run pytest' : runner === 'poetry' ? 'poetry run pytest' : 'pytest';
    found('python', pyManifest, cmd, `${pyManifest}: ${cmd}${runner === 'uv' ? ' (uv.lock)' : runner === 'poetry' ? ' (poetry.lock)' : ''}`);
  }

  if (has('Gemfile')) {
    const rspec = has('.rspec');
    found('ruby', 'Gemfile', rspec ? 'bundle exec rspec' : 'bundle exec rake test', rspec ? 'Gemfile with .rspec: bundle exec rspec' : 'Gemfile: bundle exec rake test');
  }

  const gradle = ['build.gradle', 'build.gradle.kts'].find(has);
  if (gradle) {
    const wrapper = has('gradlew');
    found('gradle', gradle, wrapper ? './gradlew test' : 'gradle test', wrapper ? `${gradle} with gradlew: ./gradlew test` : `${gradle} without a wrapper: gradle test`);
  }

  if (has('pom.xml')) {
    const wrapper = has('mvnw');
    found('maven', 'pom.xml', wrapper ? './mvnw -q test' : 'mvn -q test', wrapper ? 'pom.xml with mvnw: ./mvnw -q test' : 'pom.xml without a wrapper: mvn -q test');
  }

  if (has('mix.exs')) found('elixir', 'mix.exs', 'mix test', 'mix.exs: mix test');

  const dotnet = names.find((n) => n.endsWith('.sln') || n.endsWith('.csproj'));
  if (dotnet) found('dotnet', dotnet, 'dotnet test', `${dotnet}: dotnet test`);

  if (record.checkCommand === undefined) record.reasons.push(record.kinds.length ? 'no found toolchain supplied a check command' : 'no recognised manifest in the repository root');
  return record;
}
