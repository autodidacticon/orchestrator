/**
 * Fake `codex exec`: stands in for the Codex CLI in model-free tests. Named by
 * `runner.codex.command` (or placed first on PATH as `codex`). It parses the flags
 * the Codex runner composes, records the `-c` overrides in
 * `.orchestrator/fake-codex-args.json`, reads the prompt from stdin, runs the
 * scripted behaviour named by the task payload through the HTTP API (it is not a
 * model and calls no MCP tool), and prints fact-shaped JSONL on stdout from the
 * fixture named by the task payload's `codexFixture` (default git-events.jsonl).
 * See specs/worker-runners "Codex runner command composition" and "Codex usage parsing".
 */
import { mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../fixtures/codex');

const VALUE_FLAGS = new Set(['-c', '-s', '-m', '-C', '-o']);
const BOOLEAN_FLAGS = new Set(['--json', '--ephemeral', '--ignore-user-config']);

interface Parsed {
  overrides: string[];
  model?: string;
  sandbox?: string;
  cd?: string;
  outFile?: string;
  flags: string[];
  prompt?: string;
}

function parse(argv: string[]): Parsed {
  if (argv[0] !== 'exec') throw new Error(`fake codex: expected the exec subcommand, got ${argv[0] ?? '(none)'}`);
  const p: Parsed = { overrides: [], flags: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`fake codex: ${a} needs a value`);
      if (a === '-c') p.overrides.push(v);
      else if (a === '-m') p.model = v;
      else if (a === '-s') p.sandbox = v;
      else if (a === '-C') p.cd = v;
      else p.outFile = v;
    } else if (BOOLEAN_FLAGS.has(a)) p.flags.push(a);
    else if (a.startsWith('-') && a !== '-') throw new Error(`fake codex: unknown flag ${a}`);
    else p.prompt = a;
  }
  return p;
}

/** `key=value` with the value as TOML; JSON covers the strings, arrays, numbers, and booleans the runner sends. */
function overrideMap(overrides: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of overrides) {
    const i = o.indexOf('=');
    const [k, v] = i < 0 ? [o, ''] : [o.slice(0, i), o.slice(i + 1)];
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const out = (line: string) => writeSync(1, `${line}\n`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const p = parse(argv);
  if (p.cd) process.chdir(p.cd);
  // The prompt comes from stdin when the positional is `-` or absent.
  const prompt = p.prompt === undefined || p.prompt === '-' ? readFileSync(0, 'utf8') : p.prompt;
  const orchDir = path.join(process.cwd(), '.orchestrator');
  const briefPath = path.join(orchDir, 'brief.json');
  const brief = JSON.parse(readFileSync(briefPath, 'utf8')) as { task: Record<string, unknown> };

  // Written before the behaviour runs, so a test can read it while the fake hangs.
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(
    path.join(orchDir, 'fake-codex-args.json'),
    JSON.stringify({ argv, cwd: process.cwd(), model: p.model, sandbox: p.sandbox, outFile: p.outFile, flags: p.flags, overrides: overrideMap(p.overrides), promptBytes: Buffer.byteLength(prompt) }, null, 2),
  );

  const fixture = readFileSync(path.join(fixtureDir, String(brief.task['codexFixture'] ?? 'git-events.jsonl')), 'utf8').trimEnd().split('\n');
  const head = fixture.findIndex((l) => l.includes('"turn.started"')) + 1;
  for (const l of fixture.slice(0, head)) out(l);
  process.stderr.write('Reading prompt from stdin...\n');

  process.argv = [process.argv[0]!, path.join(here, 'scripted.ts'), briefPath];
  const { finished } = (await import('./scripted.js')) as { finished: Promise<void> };
  await finished;

  for (const l of fixture.slice(head)) out(l);
  if (p.outFile) {
    const last = fixture
      .map((l) => JSON.parse(l) as { type?: string; item?: { type?: string; text?: string } })
      .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
      .pop();
    writeFileSync(p.outFile, `${last?.item?.text ?? ''}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`fake codex: ${String(err)}\n`);
  process.exit(1);
});
