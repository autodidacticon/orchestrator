#!/usr/bin/env node
// Work loop by runner kind: the pull-mode worker of the Codex and OpenCode hosts, the counterpart
// of the Claude Code work workflow. N loops in one process claim prepared launches of one kind
// over HTTP (workerId <runTag>-<n>, runner "codex" or "opencode"), run the agent CLI in the claimed
// worktree with the command a spawned launch gets (composeCodexCommand or composeOpenCodeCommand),
// post the summed usage after it exits, and claim again until the stop rule holds. A small adapter
// per kind (ADAPTERS) holds everything that differs. While the agent runs, a watcher ends its process
// group when the daemon has ended the launch or the agent has been silent past the silence limit.
// See specs/host-integration "Work loop by runner kind" and "Work loop ends a hung agent".
//
//   orchestrator-work [--runner codex|opencode] [--workers N] [--run-tag T] [--capacity C] [--url URL]
//                     [--repo DIR] [--idle-exit-ms MS] [--poll-ms MS] [--max-failures N] [--max-silence-ms MS]
//
// Dependency-light: node built-ins plus the orchestrator package this file ships in, found the
// way bin/orchestrator.mjs finds it (a checkout, the host-local install, else npx at the pinned
// version). Start it from a shell; a background process outliving an agent turn is unverified.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PACKAGE_NAME = '@autodidacticon/orchestrator';
export const RUNNER_KINDS = ['codex', 'opencode'];
const DEFAULT_RUNNER = 'codex';
const WAKE_KINDS = 'launch.claimable,launch.ended,launch.released';
/** The silence limit when neither --max-silence-ms nor the claim names one: the daemon's default health.stuckFailAfterMs. */
export const DEFAULT_MAX_SILENCE_MS = 45 * 60_000;
/** How long an agent whose launch has reported may keep running (its last output carries the usage) before it is ended. */
export const REPORT_GRACE_MS = 30_000;
/** SIGTERM to SIGKILL. */
export const KILL_GRACE_MS = 5000;
const hostDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The package modules the loop needs for `kind`, from the first source that applies: (a) a checkout
 * or an installed package (hosts/codex sits two levels below the package root): the built dist, or
 * the TypeScript source when this process runs under the tsx loader; (b) the host-local install.
 * `runner` is the kind's module (src/runner/<kind>); `codex` names it too for a codex loop.
 * Undefined when neither has them; the caller then re-runs itself through npx.
 */
export function packageModules(kind = DEFAULT_RUNNER) {
  const roots = [];
  const root = path.resolve(hostDir, '..', '..');
  if (readJson(path.join(root, 'package.json'))?.name === PACKAGE_NAME) roots.push({ root, checkout: true });
  roots.push({ root: path.join(hostDir, 'node_modules', ...PACKAGE_NAME.split('/')), checkout: false });
  const underTsx = process.execArgv.some((a) => a.includes('tsx'));
  const named = (runner, cli) => ({ runner, cli, ...(kind === 'codex' ? { codex: runner } : {}) });
  for (const { root: r, checkout } of roots) {
    const ts = path.join(r, 'src', 'runner', `${kind}.ts`);
    if (checkout && underTsx && existsSync(ts)) return named(ts, path.join(r, 'src', 'operator', 'cli.ts'));
    const js = path.join(r, 'dist', 'src', 'runner', `${kind}.js`);
    if (existsSync(js)) return named(js, path.join(r, 'dist', 'src', 'operator', 'cli.js'));
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
      runner: { type: 'string', default: DEFAULT_RUNNER },
      workers: { type: 'string', default: '1' },
      'run-tag': { type: 'string' },
      capacity: { type: 'string' },
      url: { type: 'string' },
      repo: { type: 'string' },
      'idle-exit-ms': { type: 'string', default: '120000' },
      'poll-ms': { type: 'string', default: '2000' },
      'max-failures': { type: 'string', default: '3' },
      'max-silence-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (!RUNNER_KINDS.includes(values.runner)) throw new Error(`--runner must be one of ${RUNNER_KINDS.join(', ')}; got ${values.runner}`);
  const requested = Math.max(1, Math.min(16, Number.parseInt(values.workers, 10) || 1));
  const capacity = values.capacity === undefined ? undefined : Number.parseInt(values.capacity, 10);
  // A loop beyond the daemon's capacity would only poll for a slot that is never filled.
  const workers = Number.isInteger(capacity) && capacity > 0 && capacity < requested ? capacity : requested;
  if (workers !== requested) log(`workers clamped from ${requested} to the run's capacity ${workers}`);
  return {
    help: values.help === true,
    runner: values.runner,
    workers,
    runTag: values['run-tag'] || `${values.runner}-${process.pid.toString(36)}`,
    url: values.url,
    repo: values.repo,
    idleExitMs: Math.max(0, Number(values['idle-exit-ms']) || 0),
    pollMs: Math.max(100, Number(values['poll-ms']) || 2000),
    maxFailures: Math.max(1, Number.parseInt(values['max-failures'], 10) || 3),
    // Undefined: learnt from the claim, else DEFAULT_MAX_SILENCE_MS. 0 turns the silence limit off.
    maxSilenceMs: values['max-silence-ms'] === undefined ? undefined : Math.max(0, Number(values['max-silence-ms']) || 0),
  };
}

/**
 * The stop rule, read from GET /v1/status: the run finished or stalled; or nothing is claimable
 * for the kind and no launch of it is live while questions or reviews wait on a human; or that
 * quiet has lasted `idleExitMs` (a run whose remaining work is for another kind, or not yet
 * prepared). A paused run is never quiet, and neither is one with a task awaiting the verifier
 * (`verifying`): its result can unlock dependents or send it back for another launch. A review is
 * a milestone in `awaitingReview`; the verifying tasks listed there wait on no human.
 */
export function stopVerdict(s, quietSinceMs, now, idleExitMs, kind = DEFAULT_RUNNER) {
  if (s.finished === true) return { stop: true, why: 'the run is finished' };
  if (s.stalled === true) return { stop: true, why: 'the run is stalled' };
  const claimable = Number(s.claimableByKind?.[kind] ?? 0);
  const live = (s.liveLaunches ?? []).some((l) => (l.runner ?? 'claude-code') === kind);
  const verifying = new Set(s.verifying ?? []);
  const quiet = claimable === 0 && !live && verifying.size === 0 && s.paused !== true;
  if (!quiet) return { stop: false, quiet: false };
  const reviews = (s.awaitingReview ?? []).filter((id) => !verifying.has(id));
  if ((s.openQuestions ?? []).length || reviews.length) return { stop: true, why: `nothing is claimable for ${kind} and the run waits on a human` };
  if (quietSinceMs !== undefined && now - quietSinceMs >= idleExitMs) return { stop: true, why: `nothing claimable for ${kind} for ${idleExitMs}ms` };
  return { stop: false, quiet: true };
}

/**
 * The silence limit for one claimed launch: --max-silence-ms when given, else the daemon's stuck-fail
 * threshold when the claim carries one (`health.stuckFailAfterMs`), else DEFAULT_MAX_SILENCE_MS; 0 is off.
 */
export function silenceLimitMs(optMs, claim) {
  if (optMs !== undefined) return optMs;
  const fromClaim = Number(claim?.health?.stuckFailAfterMs);
  return Number.isFinite(fromClaim) && fromClaim > 0 ? fromClaim : DEFAULT_MAX_SILENCE_MS;
}

/**
 * Where the daemon has the claimed launch, from GET /v1/status: 'running' or 'waiting' while the worker
 * still holds it; 'reported' when its task submitted or is done; 'ended' otherwise (failed, stuck, lease
 * expired, cancelled, released, superseded by a relaunch).
 */
export function launchState(s, workerId, c) {
  const by = s.byStatus ?? {};
  if ((by.submitted ?? []).includes(c.taskId) || (by.done ?? []).includes(c.taskId)) return 'reported';
  const holds = (s.workers ?? []).some((w) => w.id === workerId && w.launchId === c.launchId);
  if (holds && (by.waiting ?? []).includes(c.taskId)) return 'waiting';
  if (holds && (by.running ?? []).includes(c.taskId)) return 'running';
  return 'ended';
}

/**
 * The watcher's verdict for one look: `{ why, hung }` to end the agent, or undefined. Silence is not
 * counted while the task waits on an answer (the agent is in a long-poll); the caller resets its clock then.
 */
export function watchVerdict(state, { now, lastOutputAt, reportedAt, maxSilenceMs, reportGraceMs = REPORT_GRACE_MS }) {
  if (state === 'ended') return { why: 'the daemon ended the launch', hung: true };
  if (state === 'reported') {
    return reportedAt !== undefined && now - reportedAt >= reportGraceMs ? { why: `the launch reported ${Math.round(reportGraceMs / 1000)}s ago and the agent has not exited`, hung: false } : undefined;
  }
  if (state === 'waiting') return undefined;
  if (maxSilenceMs > 0 && now - lastOutputAt >= maxSilenceMs) return { why: `no output for ${Math.round((now - lastOutputAt) / 1000)}s (limit ${maxSilenceMs}ms)`, hung: true };
  return undefined;
}

/** End a detached child's process group: SIGTERM, then SIGKILL after `graceMs`, sent even if the shell has gone, for the agent it started. */
export function killGroup(child, graceMs = KILL_GRACE_MS) {
  const send = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* gone */
    }
  };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), graceMs).unref();
}

/** The text fed to the agent on stdin: a short preamble (credentials, the 401 rule), then the brief. */
export function workerPreamble(c, workerId, kind = DEFAULT_RUNNER) {
  const pending = c.pending;
  const [who, tools] =
    kind === 'opencode'
      ? ['an OpenCode worker started by the orchestrator\'s work loop', 'the orchestrator MCP server\'s tools (orchestrator_heartbeat, orchestrator_report, orchestrator_block, orchestrator_inbox, orchestrator_log)']
      : ["a Codex worker started by the orchestrator's Codex work loop", "the orchestrator MCP server's tools (heartbeat, report, block, inbox, log)"];
  return [
    `You are ${who} (worker ${workerId}). You hold claimed launch ${c.launchId} for task ${c.taskId}; work only in ${c.worktree}.`,
    `Credentials: ${tools} already carry this launch's identity and token. Use them for every report and question; do not call the HTTP API from a command.`,
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

/**
 * The per-kind adapter: `block(claim)` is the claim's settings block (undefined from an older daemon);
 * `prepare(launch, block)` writes what the shim needs and returns the env additions for the CLI;
 * `compose(launch, block, promptFile)` is the shell command; `started(text, failure)` says whether a
 * turn began; `parseUsage` and `classifyFailure` read the combined output. Built from the kind's module.
 */
export function makeAdapter(kind, mod) {
  if (kind === 'opencode') {
    const { composeOpenCodeCommand, openCodeConfig, prepareOpenCodeLaunch, parseOpenCodeUsage, classifyOpenCodeFailure } = mod;
    return {
      kind,
      label: 'opencode run',
      block: (c) => c.opencode,
      async prepare(launch, oc) {
        const config = openCodeConfig(oc.settings, oc.allowedTools ?? [], oc.maxWaitMs, undefined, launch.checkCommand);
        // The MCP child inherits this environment, so the shim gets its identity from it; no env file.
        return { ORCH_RETRY_WINDOW_MS: String(oc.retryWindowMs ?? 60_000), ...(await prepareOpenCodeLaunch(launch, oc.settings, config)) };
      },
      compose: (launch, oc, brief) => composeOpenCodeCommand(launch, { template: oc.settings.command, settings: oc.settings, brief }),
      // No JSONL event at all means opencode never began a session (exitBeforeTurn, startupContended).
      started: (_text, failure) => !failure || (failure.reason !== 'exitBeforeTurn' && failure.reason !== 'startupContended'),
      parseUsage: parseOpenCodeUsage,
      classifyFailure: classifyOpenCodeFailure,
    };
  }
  const { composeCodexCommand, writeCodexShimEnv, parseCodexUsage, classifyCodexFailure } = mod;
  return {
    kind,
    label: 'codex exec',
    block: (c) => c.codex,
    async prepare(launch, cx) {
      await writeCodexShimEnv(launch, cx.env ?? {}, cx.retryWindowMs ?? 60_000);
      return {};
    },
    compose: (launch, cx, brief) => composeCodexCommand(launch, { template: cx.settings.command, settings: cx.settings, maxWaitMs: cx.maxWaitMs, brief }),
    started: (text) => text.includes('"turn.started"'),
    parseUsage: parseCodexUsage,
    classifyFailure: classifyCodexFailure,
  };
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
  const kind = opts.runner ?? DEFAULT_RUNNER;
  const adapter = makeAdapter(kind, await import(pathToFileURL(mods.runner ?? mods.codex).href));
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
    log(`${sig}: stopping; live ${kind} processes are terminated and their launches released with keep`);
    for (const { child } of active.values()) killGroup(child);
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

  /** One claimed launch: compose, run, post usage, hand back what the agent did not report. 'started' | 'startFailed' | 'contended' | 'noReport' | 'hung'. */
  async function work(workerId, c) {
    const blk = adapter.block(c);
    if (!blk) {
      await release(c, `the daemon sent no ${kind} settings with the claim (an older daemon)`, false);
      return 'startFailed';
    }
    const orchDir = path.join(c.worktree, '.orchestrator');
    const launch = { worktree: c.worktree, launchId: c.launchId, taskId: c.taskId, token: c.token, model: c.model, effort: c.effort, checkCommand: c.brief?.checkCommand };
    const extraEnv = await adapter.prepare(launch, blk);
    const brief = await readFile(c.briefPath ?? path.join(orchDir, 'brief.md'), 'utf8').catch(() => '');
    const promptFile = path.join(orchDir, `${kind}-work-prompt.md`);
    await writeFile(promptFile, workerPreamble(c, workerId, kind) + brief, 'utf8');
    const cmd = adapter.compose(launch, blk, promptFile);
    const logFile = path.join(orchDir, `${kind}-work.log`);
    const out = createWriteStream(logFile, { flags: 'a' });
    let text = '';
    let spawnError;
    let terminated;
    const maxSilenceMs = silenceLimitMs(opts.maxSilenceMs, c);
    log(`${workerId}: ${c.taskId} (launch ${c.launchId.slice(0, 8)}) ${adapter.label} -m ${c.model ?? '(default)'}; log ${logFile}; silence limit ${maxSilenceMs ? `${maxSilenceMs}ms` : 'off'}`);
    const exit = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('/bin/sh', ['-c', `${cmd}\n# orch-launch:${c.launchId}`], { cwd: c.worktree, env: agentProcessEnv({ ...blk.env, ...extraEnv }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        spawnError = err;
        resolve({ code: null, signal: null });
        return;
      }
      active.set(workerId, { child, launchId: c.launchId });
      let closed = false;
      let lastOutputAt = Date.now();
      let reportedAt;
      const take = (chunk) => {
        lastOutputAt = Date.now();
        text += chunk.toString('utf8');
        if (text.length > 1024 * 1024) text = text.slice(text.length - 512 * 1024);
        out.write(chunk);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err) => {
        spawnError = err;
      });
      child.on('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
      // The watcher: an agent that hangs (a provider stream error, a turn that never ends) is ended here, not waited on.
      void (async () => {
        while (!closed && !terminated && !stopping) {
          await sleep(opts.pollMs);
          if (closed || stopping) return;
          let state;
          try {
            const s = await http('GET', '/v1/status');
            state = s.status === 200 ? launchState(s.body, workerId, c) : 'running';
          } catch {
            state = 'running'; // the daemon is unreachable: only the silence limit applies
          }
          const now = Date.now();
          if (state === 'waiting') lastOutputAt = now;
          if (state === 'reported') reportedAt ??= now;
          const v = watchVerdict(state, { now, lastOutputAt, reportedAt, maxSilenceMs });
          if (v && !closed) {
            terminated = v;
            log(`${workerId}: ${c.taskId} ending ${kind} (process group ${child.pid}): ${v.why}`);
            killGroup(child);
          }
        }
      })();
    });
    active.delete(workerId);
    await new Promise((r) => out.end(r));

    const usage = adapter.parseUsage(text);
    if (usage?.tokens) {
      // opencode reports a cost per step; codex reports none, and the daemon prices the tokens.
      const cost = typeof usage.costUsd === 'number' && usage.costUsd > 0 ? { costUsd: usage.costUsd } : {};
      const r = await http('POST', `/v1/launches/${c.launchId}/usage`, { workerId, usage: { tokens: usage.tokens, ...(c.model ? { model: c.model } : {}), ...cost } });
      if (r.status !== 200) log(`${c.taskId}: usage post -> ${r.status} ${r.body.reason ?? r.body.error ?? ''}`);
    }
    const failure = spawnError ? { reason: 'exitBeforeTurn', detail: String(spawnError) } : adapter.classifyFailure(text);
    const startFailed = Boolean(spawnError) || exit.code === 127 || !adapter.started(text, failure);
    const held = await stillHeld(workerId, c);
    log(`${workerId}: ${c.taskId} ${kind} exited (code ${exit.code}${exit.signal ? `, ${exit.signal}` : ''})${terminated ? ` terminated: ${terminated.why}` : failure ? ` ${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}` : ''}${held ? '; no report' : ''}`);
    if (terminated && !stopping) {
      // Ended by the watcher, not a start failure, whatever the output says. The daemon's own verdict (failed, stuck, lease
      // expired) stands; a launch still held was silent past the limit and is handed back as an agent failure, without keep.
      if (held) await release(c, `${kind} was terminated by the work loop: ${terminated.why}`, false);
      return terminated.hung ? 'hung' : 'started';
    }
    if (!held) return 'started';
    if (stopping) {
      await release(c, `the ${kind} work loop was stopped`, true);
      return 'started';
    }
    if (startFailed) {
      // Nothing ran: hand the launch back with whatever is on the branch so the next claim starts from it.
      // A startupContended death (another opencode held the shared database) is released the same way, for a relaunch at no cost.
      await release(c, `${kind} failed to start${failure ? `: ${failure.reason}${failure.detail ? ` (${failure.detail})` : ''}` : ''}`, true);
      return failure?.reason === 'startupContended' ? 'contended' : 'startFailed';
    }
    await release(c, `${kind} exited without a report${failure ? `: ${failure.reason}` : ''}`, false);
    return 'noReport';
  }

  async function loop(n) {
    const workerId = `${opts.runTag}-${n}`;
    // Stagger the loops' first claims, so that agents sharing one data directory do not all start in the same instant.
    if (n > 1) await sleep((n - 1) * 300);
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
    const c = await http('POST', '/v1/claims', { workerId, access: 'local', runner: kind });
    if (c.status === 200) {
      st.quietSince = undefined;
      const result = await work(workerId, c.body);
      outcomes.push({ worker: workerId, taskId: c.body.taskId, launchId: c.body.launchId, result });
      // A contended start still counts, so a database that stays locked cannot spin the loop forever.
      st.failures = result === 'started' ? 0 : st.failures + 1;
      if (st.failures >= opts.maxFailures) {
        log(`${workerId}: ${st.failures} launches in a row ended without ${kind} running or reporting; this loop stops`);
        return 'stop';
      }
      // Back off a little after a contended start so the other agent's startup can finish.
      if (result === 'contended') await sleep(500 + Math.floor(Math.random() * 1000));
      return 'continue';
    }
    if (c.status !== 404 && c.status !== 409) log(`${workerId}: claim -> ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
    const s = await http('GET', '/v1/status');
    if (s.status === 200) {
      const now = Date.now();
      const v = stopVerdict(s.body, st.quietSince, now, opts.idleExitMs, kind);
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

  log(`${opts.workers} ${kind} loop(s) as ${opts.runTag}-1..${opts.workers} against ${base}`);
  await Promise.all(Array.from({ length: opts.workers }, (_, i) => loop(i + 1)));
  return { runTag: opts.runTag, runner: kind, workers: opts.workers, outcomes };
}

const USAGE = `usage: orchestrator-work [--runner <codex|opencode>] [--workers N] [--run-tag T] [--capacity C]
                         [--url URL] [--repo DIR] [--idle-exit-ms MS] [--poll-ms MS] [--max-failures N]
                         [--max-silence-ms MS]
Claims launches of one runner kind from the orchestrator daemon and runs the agent CLI for each:
codex exec for --runner codex (the default), opencode run for --runner opencode. The daemon is
found by --url, ORCH_URL, or the run directory of --repo (default: the current directory).
The agent's process group is ended when the daemon ends its launch, or when the agent writes no
output for --max-silence-ms (default: the claim's health.stuckFailAfterMs, else 45 minutes; 0 is off).\n`;

async function main() {
  let opts;
  try {
    opts = parseWorkArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`orchestrator-work: ${err?.message ?? err}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const mods = packageModules(opts.runner);
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
