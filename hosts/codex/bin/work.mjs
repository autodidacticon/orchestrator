#!/usr/bin/env node
// Codex work loop: the Codex host's pull-mode worker, the counterpart of the Claude Code
// work workflow. N loops in one process claim prepared codex launches over HTTP
// (workerId <runTag>-<n>, runner "codex"), run `codex exec` in the claimed worktree with the
// command a spawned launch gets (composeCodexCommand), post the summed usage after codex
// exits, and claim again until the stop rule holds. See specs/host-integration "Codex work loop".
//
//   orchestrator-work [--workers N] [--run-tag T] [--capacity C] [--url URL] [--repo DIR]
//                     [--idle-exit-ms MS] [--poll-ms MS] [--max-failures N]
//
// Dependency-light: node built-ins plus the orchestrator package this file ships in, found the
// way bin/orchestrator.mjs finds it (a checkout, the host-local install, else npx at the pinned
// version). Start it from a shell; a background process outliving a Codex turn is unverified.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PACKAGE_NAME = '@autodidacticon/orchestrator';
const RUNNER = 'codex';
const WAKE_KINDS = 'launch.claimable,launch.ended,launch.released';
const hostDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The package modules the loop needs, from the first source that applies: (a) a checkout or an
 * installed package (hosts/codex sits two levels below the package root): the built dist, or the
 * TypeScript source when this process runs under the tsx loader; (b) the host-local install.
 * Undefined when neither has them; the caller then re-runs itself through npx.
 */
export function packageModules() {
  const roots = [];
  const root = path.resolve(hostDir, '..', '..');
  if (readJson(path.join(root, 'package.json'))?.name === PACKAGE_NAME) roots.push({ root, checkout: true });
  roots.push({ root: path.join(hostDir, 'node_modules', ...PACKAGE_NAME.split('/')), checkout: false });
  const underTsx = process.execArgv.some((a) => a.includes('tsx'));
  for (const { root: r, checkout } of roots) {
    const ts = path.join(r, 'src', 'runner', 'codex.ts');
    if (checkout && underTsx && existsSync(ts)) return { codex: ts, cli: path.join(r, 'src', 'operator', 'cli.ts') };
    const js = path.join(r, 'dist', 'src', 'runner', 'codex.js');
    if (existsSync(js)) return { codex: js, cli: path.join(r, 'dist', 'src', 'operator', 'cli.js') };
    const loader = path.join(r, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    if (checkout && existsSync(ts) && existsSync(loader)) return { reexec: ['--import', loader] };
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  process.stderr.write(`${new Date().toISOString()} orchestrator-work: ${line}\n`);
}

/** Parse and clamp the arguments; `workers` is clamped to `capacity` with a log line. */
export function parseWorkArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      workers: { type: 'string', default: '1' },
      'run-tag': { type: 'string' },
      capacity: { type: 'string' },
      url: { type: 'string' },
      repo: { type: 'string' },
      'idle-exit-ms': { type: 'string', default: '120000' },
      'poll-ms': { type: 'string', default: '2000' },
      'max-failures': { type: 'string', default: '3' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const requested = Math.max(1, Math.min(16, Number.parseInt(values.workers, 10) || 1));
  const capacity = values.capacity === undefined ? undefined : Number.parseInt(values.capacity, 10);
  // A loop beyond the daemon's capacity would only poll for a slot that is never filled.
  const workers = Number.isInteger(capacity) && capacity > 0 && capacity < requested ? capacity : requested;
  if (workers !== requested) log(`workers clamped from ${requested} to the run's capacity ${workers}`);
  return {
    help: values.help === true,
    workers,
    runTag: values['run-tag'] || `codex-${process.pid.toString(36)}`,
    url: values.url,
    repo: values.repo,
    idleExitMs: Math.max(0, Number(values['idle-exit-ms']) || 0),
    pollMs: Math.max(100, Number(values['poll-ms']) || 2000),
    maxFailures: Math.max(1, Number.parseInt(values['max-failures'], 10) || 3),
  };
}

/**
 * The stop rule, read from GET /v1/status: the run finished or stalled; or nothing is claimable
 * for codex and no codex launch is live while questions or reviews wait on a human; or that
 * quiet has lasted `idleExitMs` (a run whose remaining work is for another kind, or not yet
 * prepared). A paused run is never quiet.
 */
export function stopVerdict(s, quietSinceMs, now, idleExitMs) {
  if (s.finished === true) return { stop: true, why: 'the run is finished' };
  if (s.stalled === true) return { stop: true, why: 'the run is stalled' };
  const claimable = Number(s.claimableByKind?.[RUNNER] ?? 0);
  const live = (s.liveLaunches ?? []).some((l) => (l.runner ?? 'claude-code') === RUNNER);
  const quiet = claimable === 0 && !live && s.paused !== true;
  if (!quiet) return { stop: false, quiet: false };
  if ((s.openQuestions ?? []).length || (s.awaitingReview ?? []).length) return { stop: true, why: 'nothing is claimable for codex and the run waits on a human' };
  if (quietSinceMs !== undefined && now - quietSinceMs >= idleExitMs) return { stop: true, why: `nothing claimable for codex for ${idleExitMs}ms` };
  return { stop: false, quiet: true };
}

/** The text fed to codex on stdin: a short preamble (credentials, the 401 rule), then the brief. */
export function workerPreamble(c, workerId) {
  const pending = c.pending;
  return [
    `You are a Codex worker started by the orchestrator's Codex work loop (worker ${workerId}). You hold claimed launch ${c.launchId} for task ${c.taskId}; work only in ${c.worktree}.`,
    "Credentials: the orchestrator MCP server's tools (heartbeat, report, block, inbox, log) already carry this launch's identity and token. Use them for every report and question; do not call the HTTP API from a command.",
    'If any orchestrator tool returns 401, your launch has been revoked: stop immediately.',
    'Never write a fallback report file, whatever the brief says about one: this launch has no process the orchestrator watches, so the file is never read. If a tool call fails because the orchestrator cannot be reached, retry it.',
    ...(pending
      ? [`A question was asked earlier with seq ${pending.seq}${pending.answer !== undefined ? ` and the answer is: ${pending.answer}` : '; call block with that seq to collect the answer before continuing'}.`]
      : []),
    '',
    'The brief:',
    '',
  ].join('\n');
}

export function makeClient(base, retryWindowMs = 60_000) {
  return async function http(method, route, body) {
    const deadline = Date.now() + retryWindowMs;
    let delay = 200;
    for (;;) {
      try {
        const res = await fetch(`${base}${route}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        });
        let json = {};
        try {
          json = await res.json();
        } catch {
          /* empty body */
        }
        return { status: res.status, body: json };
      } catch (err) {
        if (Date.now() + delay > deadline) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
      }
    }
  };
}

/** The child environment: this process's minus every ORCH_* variable, then the launch's agent environment; an empty value removes a key. */
function agentProcessEnv(agentEnv) {
  const merged = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ORCH_')) merged[k] = v;
  for (const [k, v] of Object.entries(agentEnv ?? {})) merged[k] = v;
  for (const k of Object.keys(merged)) if (merged[k] === '' || merged[k] === undefined) delete merged[k];
  return merged;
}

export async function runWork(opts, mods) {
  const { composeCodexCommand, writeCodexShimEnv, parseCodexUsage, classifyCodexFailure } = await import(pathToFileURL(mods.codex).href);
  let base = opts.url ?? process.env.ORCH_URL;
  if (!base) {
    const { resolveUrl } = await import(pathToFileURL(mods.cli).href);
    base = await resolveUrl({ repo: opts.repo });
  }
  base = base.replace(/\/+$/, '');
  const http = makeClient(base);
  const active = new Map();
  let stopping = false;
  const outcomes = [];

  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping; live codex processes are terminated and their launches released with keep`);
    for (const { child } of active.values()) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => onSignal(sig));

  async function stillHeld(workerId, c) {
    const s = await http('GET', '/v1/status');
    if (s.status !== 200) return false;
    const holds = (s.body.workers ?? []).some((w) => w.id === workerId && w.launchId === c.launchId);
    const by = s.body.byStatus ?? {};
    return holds && ((by.running ?? []).includes(c.taskId) || (by.waiting ?? []).includes(c.taskId));
  }

  async function release(c, reason, keep) {
    const r = await http('POST', `/v1/launches/${c.launchId}/release`, { reason, keep });
    log(`${c.taskId}: released (${reason}; keep ${keep}) -> ${r.status} ${r.body.outcome ?? r.body.reason ?? ''}`);
  }

  /** One claimed launch: compose, run, post usage, hand back what codex did not report. 'started' | 'startFailed' | 'noReport'. */
  async function work(workerId, c) {
    const cx = c.codex;
    if (!cx) {
      await release(c, 'the daemon sent no codex settings with the claim (an older daemon)', false);
      return 'startFailed';
    }
    const orchDir = path.join(c.worktree, '.orchestrator');
    await writeCodexShimEnv({ worktree: c.worktree, launchId: c.launchId, token: c.token }, cx.env ?? {}, cx.retryWindowMs ?? 60_000);
    const brief = await readFile(c.briefPath ?? path.join(orchDir, 'brief.md'), 'utf8').catch(() => '');
    const promptFile = path.join(orchDir, 'codex-work-prompt.md');
    await writeFile(promptFile, workerPreamble(c, workerId) + brief, 'utf8');
    const cmd = composeCodexCommand(
      { worktree: c.worktree, launchId: c.launchId, taskId: c.taskId, model: c.model, effort: c.effort },
      { template: cx.settings.command, settings: cx.settings, maxWaitMs: cx.maxWaitMs, brief: promptFile },
    );
    const logFile = path.join(orchDir, 'codex-work.log');
    const out = createWriteStream(logFile, { flags: 'a' });
    let text = '';
    let spawnError;
    log(`${workerId}: ${c.taskId} (launch ${c.launchId.slice(0, 8)}) codex exec -m ${c.model ?? '(default)'}; log ${logFile}`);
    const exit = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('/bin/sh', ['-c', `${cmd}\n# orch-launch:${c.launchId}`], { cwd: c.worktree, env: agentProcessEnv(cx.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        spawnError = err;
        resolve({ code: null, signal: null });
        return;
      }
      active.set(workerId, { child, launchId: c.launchId });
      const take = (chunk) => {
        text += chunk.toString('utf8');
        if (text.length > 1024 * 1024) text = text.slice(text.length - 512 * 1024);
        out.write(chunk);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err) => {
        spawnError = err;
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    active.delete(workerId);
    await new Promise((r) => out.end(r));

    const usage = parseCodexUsage(text);
    if (usage) {
      const r = await http('POST', `/v1/launches/${c.launchId}/usage`, { workerId, usage: { tokens: usage.tokens, ...(c.model ? { model: c.model } : {}) } });
      if (r.status !== 200) log(`${c.taskId}: usage post -> ${r.status} ${r.body.reason ?? r.body.error ?? ''}`);
    }
    const failure = spawnError ? { reason: 'exitBeforeTurn', detail: String(spawnError) } : classifyCodexFailure(text);
    const startFailed = Boolean(spawnError) || exit.code === 127 || !text.includes('"turn.started"');
    const held = await stillHeld(workerId, c);
    log(`${workerId}: ${c.taskId} codex exited (code ${exit.code}${exit.signal ? `, ${exit.signal}` : ''})${failure ? ` ${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}` : ''}${held ? '; no report' : ''}`);
    if (!held) return 'started';
    if (stopping) {
      await release(c, 'the Codex work loop was stopped', true);
      return 'started';
    }
    if (startFailed) {
      // Nothing ran: hand the launch back with whatever is on the branch so the next claim starts from it.
      await release(c, `codex failed to start${failure ? `: ${failure.reason}${failure.detail ? ` (${failure.detail})` : ''}` : ''}`, true);
      return 'startFailed';
    }
    await release(c, `codex exited without a report${failure ? `: ${failure.reason}` : ''}`, false);
    return 'noReport';
  }

  async function loop(n) {
    const workerId = `${opts.runTag}-${n}`;
    let errors = 0;
    while (!stopping) {
      try {
        if ((await cycle(workerId)) === 'stop') break;
        errors = 0;
      } catch (err) {
        // The daemon was unreachable for a whole retry window (each call retries for a minute): try again, up to ten windows.
        if (++errors >= 10) {
          log(`${workerId}: the daemon has been unreachable for ${errors} retry windows; this loop stops: ${err}`);
          break;
        }
        log(`${workerId}: ${err}; retrying`);
        await sleep(2000);
      }
    }
  }

  const loopState = new Map();
  /** One claim attempt: work a claimed launch, or read status and wait. 'stop' when the loop should end. */
  async function cycle(workerId) {
    const st = loopState.get(workerId) ?? { failures: 0, quietSince: undefined };
    loopState.set(workerId, st);
    const c = await http('POST', '/v1/claims', { workerId, access: 'local', runner: RUNNER });
    if (c.status === 200) {
      st.quietSince = undefined;
      const result = await work(workerId, c.body);
      outcomes.push({ worker: workerId, taskId: c.body.taskId, launchId: c.body.launchId, result });
      st.failures = result === 'started' ? 0 : st.failures + 1;
      if (st.failures >= opts.maxFailures) {
        log(`${workerId}: ${st.failures} launches in a row ended without codex running or reporting; this loop stops`);
        return 'stop';
      }
      return 'continue';
    }
    if (c.status !== 404 && c.status !== 409) log(`${workerId}: claim -> ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
    const s = await http('GET', '/v1/status');
    if (s.status === 200) {
      const now = Date.now();
      const v = stopVerdict(s.body, st.quietSince, now, opts.idleExitMs);
      if (v.stop) {
        log(`${workerId}: stops: ${v.why}`);
        return 'stop';
      }
      st.quietSince = v.quiet ? (st.quietSince ?? now) : undefined;
      // Long-poll for a newly parked or ended launch, so a new launch is claimed promptly. Only those kinds wake the poll: every claim appends operator.claim, and idle loops would wake each other.
      await http('GET', `/v1/events?after=${Number(s.body.latestSeq ?? 0)}&limit=1&kinds=${WAKE_KINDS}&wait=${opts.pollMs}`);
    }
    await sleep(250);
    return 'continue';
  }

  log(`${opts.workers} loop(s) as ${opts.runTag}-1..${opts.workers} against ${base}`);
  await Promise.all(Array.from({ length: opts.workers }, (_, i) => loop(i + 1)));
  return { runTag: opts.runTag, workers: opts.workers, outcomes };
}

const USAGE = `usage: orchestrator-work [--workers N] [--run-tag T] [--capacity C] [--url URL] [--repo DIR]
                         [--idle-exit-ms MS] [--poll-ms MS] [--max-failures N]
Claims codex launches from the orchestrator daemon and runs codex exec for each. The daemon is
found by --url, ORCH_URL, or the run directory of --repo (default: the current directory).\n`;

async function main() {
  const opts = parseWorkArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const mods = packageModules();
  if (!mods || mods.reexec) {
    // No package modules beside this file: run the same executable from the pinned package, or this file under tsx.
    const version = readJson(path.join(hostDir, 'package.json'))?.dependencies?.[PACKAGE_NAME] ?? 'latest';
    const [command, args] = mods?.reexec
      ? [process.execPath, [...mods.reexec, fileURLToPath(import.meta.url), ...process.argv.slice(2)]]
      : ['npx', ['--yes', `--package=${PACKAGE_NAME}@${version}`, 'orchestrator-work', ...process.argv.slice(2)]];
    const child = spawn(command, args, { stdio: 'inherit' });
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }
  const result = await runWork(opts, mods);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Entry guard through any symlink or alias path (npm bins, /var vs /private/var on macOS).
function isEntrypoint() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(path.resolve(process.argv[1])) === real(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  main().catch((err) => {
    log(`error: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
