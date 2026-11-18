#!/usr/bin/env node
/**
 * Operator CLI over the daemon's HTTP API.
 *   orchestrator-ctl status
 *   orchestrator-ctl config [--check-command <cmd>] [--capacity <n>] [--allow <rule>]... [--runner-command <cmd>] [--runner-kind <kind>] [--model <name>] [--effort <level>] [--sandbox <mode>] [--permission <derived|allow>] [--data-dir <shared|launch>] [--commit <agent|daemon>] [--set key=value]... [--clear <key>]...
 *   orchestrator-ctl answer <task> <text>
 *   orchestrator-ctl cancel <task> [--release] [--reason <text>]
 *   orchestrator-ctl reopen <task> [--cascade]
 *   orchestrator-ctl proposals [--status <pending|accepted|rejected|all>]
 *   orchestrator-ctl accept-proposal <id> [--node-id <id>] [--payload <json>]
 *   orchestrator-ctl reject-proposal <id> --note <text>
 *   orchestrator-ctl unblock <task> [--answer <text>] [--accept-candidate]
 *   orchestrator-ctl accept <milestone> --sha <sha> --version <n>
 *   orchestrator-ctl reject <milestone> --note <text>
 *   orchestrator-ctl review <milestone> [--task <id>] [--full] [--stat-lines <n>] [--summary-chars <n>]
 *   orchestrator-ctl pause | resume [--override-budget]
 *   orchestrator-ctl mode <spawn|pull|mixed>
 *   orchestrator-ctl claim <workerId> [--task <id>]
 *   orchestrator-ctl release <launchId> --reason <text> [--keep] [--head-sha <sha>] [--wip-commit <sha>]
 *   orchestrator-ctl nudge <task> <message>
 *   orchestrator-ctl logs <task> [--launch <n>]
 *   orchestrator-ctl outbox [--after <id>] [--limit <n>]
 *   orchestrator-ctl ack <id> [--result <json>] [--error <text>]
 * The daemon URL comes from --url, ORCH_URL, or the store under --data-dir. For `config`, --data-dir shared|launch
 * is the opencode.dataDir leaf, not a store location; with --url or ORCH_URL any other value is refused.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { daemonState, listRuns, reviveDaemon, startDaemon, stopDaemon } from '../runs/lifecycle.js';
import { foldRunnerArgs, NAMESPACE_OF, type Overrides, parseSetFlags } from '../runs/resolve.js';
import { isRunnerKind, OPENCODE_DATA_DIRS, type RunnerKind } from '../runner/selection.js';
import { remoteRunError, resolveRepoPath, runPaths, runStoreKind } from '../runs/runDir.js';
import { SqliteStore } from '../state/sqlite.js';
import { isEntrypoint } from '../entry.js';

export interface CliResult {
  status: number;
  body: unknown;
}

export async function resolveUrl(opts: { url?: string; dataDir?: string; repo?: string }): Promise<string> {
  if (opts.url) return opts.url;
  if (process.env['ORCH_URL']) return process.env['ORCH_URL'] as string;
  if (!opts.dataDir) {
    try {
      const repo = await resolveRepoPath({ repo: opts.repo });
      const state = await daemonState(runPaths(repo).runDir);
      if (state.healthy && state.url) return state.url;
      // An idle exit or a crash is revived on demand; an explicit stop is refused by reviveDaemon. See specs/operator-control "Revive on demand".
      const revived = await reviveDaemon({ repo });
      if (revived) {
        process.stderr.write(`daemon revived (pid ${revived.pid})\n`);
        return revived.url;
      }
      if (!process.env['ORCH_DATA_DIR']) throw new Error(`no running daemon for ${repo} (run dir ${state.runDir}); run \`orchestrator-ctl start\``);
    } catch (err) {
      if (!process.env['ORCH_DATA_DIR']) throw err;
    }
  }
  const dataDir = opts.dataDir ?? process.env['ORCH_DATA_DIR'] ?? '.orchestrator-run';
  // Opening a missing file would create an empty store; a Postgres run keeps none here. See specs/state-backend "Store selection".
  if (!existsSync(path.join(dataDir, 'store.sqlite'))) {
    if (runStoreKind(dataDir) === 'postgres') throw remoteRunError(`in ${dataDir}`);
    throw new Error(`no daemon url recorded in ${dataDir} (no store there); pass --url`);
  }
  const store = new SqliteStore(path.join(dataDir, 'store.sqlite'));
  try {
    const url = store.getKv('apiBaseUrl');
    if (!url) throw new Error(`no daemon url recorded in ${dataDir}; pass --url`);
    return url;
  } finally {
    store.close();
  }
}

export async function call(base: string, method: 'GET' | 'POST' | 'PUT', route: string, body?: Record<string, unknown>): Promise<CliResult> {
  // Bodies are JSON documents; a result may be any JSON value.
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

export const USAGE = `orchestrator-ctl: operate a running orchestrator.

  orchestrator-ctl start [--repo <path>] [--set key=value]...   start the daemon for a repository (idempotent);
                                               --set checkCommand=..., integrationBranch=..., capacity=..., allowedTools=..., runnerCommand=...,
                                               runnerKind=claude-code|codex|opencode, model=..., effort=..., claude.{model,effort,commit}=...,
                                               codex.{model,effort,sandbox,commit,command,networkAccess}=... (codex.networkAccess is true or false),
                                               opencode.{model,effort,commit,command,permission,dataDir}=...,
                                               budgets.maxLaunchMs=..., health.stuckAfterMs=..., health.stuckFailAfterMs=...
  orchestrator-ctl stop [--reap] [--repo <path>]
  orchestrator-ctl runs                         list runs under ORCH_HOME
  orchestrator-ctl status
  orchestrator-ctl config                       the resolved configuration: every key with its value and source, the toolchain, needsConfig
  orchestrator-ctl config [--check-command <cmd>] [--capacity <n>] [--allow <rule>]... [--runner-command <cmd>] [--runner-kind <kind>]
                          [--model <name>] [--effort <level>] [--sandbox <mode>] [--permission <derived|allow>]
                          [--data-dir <shared|launch>] [--commit <agent|daemon>] [--set key=value]... [--clear <key>]... [--end-live]
                                               the runner kind is claude-code (default), codex, or opencode; model and effort are the worker
                                               defaults of the kind in force (claude-code: claude-opus-5-5 at medium;
                                               codex: gpt-6-astra at medium; opencode: anthropic/claude-opus-5-5 at medium, a provider/model id);
                                               effort is low, medium, high, xhigh, or max, and ultra is codex-only; --sandbox sets codex.sandbox (read-only,
                                               workspace-write, danger-full-access); --permission sets opencode.permission (derived, allow);
                                               --data-dir shared|launch sets opencode.dataDir here, not the store location; with neither
                                               --url nor ORCH_URL any other value names the store location, as on every command, and
                                               with --url or ORCH_URL it is refused; --commit sets the commit policy of --runner-kind,
                                               else of the kind in force; --clear takes a key or one such as codex.sandbox or
                                               opencode.permission; --set takes every key start --set takes, and the limits
                                               budgets.maxLaunchMs, health.stuckAfterMs and health.stuckFailAfterMs (milliseconds as
                                               decimal digits, 0 disables the limit, a change applies on the next tick; with both stuck
                                               limits above 0, health.stuckFailAfterMs must be above health.stuckAfterMs); one call
                                               names each key once: the same key, or a key and a block holding it, given by two
                                               flags (--set, --clear, or a per-key flag) is refused before anything is sent;
                                               a change that would end a live launch (a lowered, cleared or switched-on
                                               budgets.maxLaunchMs or health.stuckFailAfterMs it is already past) is refused
                                               with 409 and wouldEnd, and nothing is applied; --end-live confirms it, and the
                                               next tick ends those launches
  orchestrator-ctl answer <task> <text>
  orchestrator-ctl cancel <task> [--release] [--reason <text>]
  orchestrator-ctl reopen <task> [--cascade]       cascade resets started dependents and returns the plan
  orchestrator-ctl proposals [--status <s>]       pending agent proposals (or accepted, rejected, all)
  orchestrator-ctl accept-proposal <id> [--node-id <id>] [--payload <json>]
  orchestrator-ctl reject-proposal <id> --note <text>
  orchestrator-ctl unblock <task> [--answer <text>] [--accept-candidate]
  orchestrator-ctl accept <milestone> --sha <sha> --version <n>
  orchestrator-ctl reject <milestone> --note <text>
  orchestrator-ctl review <milestone> [--task <id>] [--full] [--stat-lines <n>] [--summary-chars <n>]
                                               an index by default; --task: one task's whole report; --full: the
                                               whole bundle; the other two override the index cuts for this call
  orchestrator-ctl pause | resume [--override-budget]   resume is refused over the cost ceiling without the flag
  orchestrator-ctl mode <spawn|pull|mixed>         who executes launches: the daemon, workers, or both
  orchestrator-ctl claim <workerId> [--task <id>]  hand a parked launch to a worker (prints its brief, token, worktree)
  orchestrator-ctl release <launchId> --reason <text> [--keep]   keep: preserve the work on the branch at no attempt cost
                                                                 (remote launch: --head-sha <pushed tip> [--wip-commit <sha>])
  orchestrator-ctl nudge <task> <message>       queue a message for the task's running agent
  orchestrator-ctl logs <task> [--launch <n>]
  orchestrator-ctl outbox [--after <id>] [--limit <n>]   pending tracker effects and the policy
  orchestrator-ctl ack <id> [--result <json>] [--error <text>]   acknowledge (or, with --error, reject) an effect

The daemon is found by --url, ORCH_URL, the run directory of --repo or the
current repository (ORCH_HOME, default ~/.orchestrator), or --data-dir.
`;

/** Options whose value may start with a dash (`--stat-lines -1`): parseArgs refuses that form, so it is joined as `--opt=value` and the daemon judges the value. */
const DASH_VALUE_OPTIONS = new Set(['--stat-lines', '--summary-chars']);

function joinNumericValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    if (DASH_VALUE_OPTIONS.has(arg) && next !== undefined && next.startsWith('-') && !next.startsWith('--')) {
      out.push(`${arg}=${next}`);
      i++;
    } else out.push(arg);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The nested override blocks: a block named whole (`--clear health`) names every leaf under it. */
const CONFIG_BLOCKS = ['claude', 'codex', 'opencode', 'budgets', 'health'];

interface Naming {
  /** The leaves a flag names: a key, or `block.leaf`; more than one when the target is not known before the call. */
  leaves: string[];
  by: string;
}

/**
 * The leaves each source of one `config` call names: `--clear`, the per-key flags as `foldRunnerArgs` places them,
 * `--allow` as `allowedTools`, and `--set` (a repeated `--set allowedTools` appends, so it names the key once).
 */
function configNamings(values: Record<string, unknown>, dataDirLeaf: string | undefined): Naming[] {
  const out: Naming[] = [];
  for (const k of (values['clear'] as string[] | undefined) ?? []) out.push({ leaves: [k], by: `--clear ${k}` });
  const flag = (opt: string, leaf: string) => {
    if (values[opt] !== undefined) out.push({ leaves: [leaf], by: `--${opt}` });
  };
  flag('check-command', 'checkCommand');
  flag('capacity', 'capacity');
  flag('runner-command', 'runnerCommand');
  flag('runner-kind', 'runnerKind');
  flag('model', 'model');
  flag('effort', 'effort');
  flag('sandbox', 'codex.sandbox');
  flag('permission', 'opencode.permission');
  if (dataDirLeaf !== undefined) out.push({ leaves: ['opencode.dataDir'], by: '--data-dir' });
  if (values['commit'] !== undefined) {
    // The policy binds to --runner-kind, else to the kind in force, which is not known before the call: it then names every kind's commit leaf.
    const kind = values['runner-kind'];
    out.push({ leaves: isRunnerKind(kind) ? [`${NAMESPACE_OF[kind]}.commit`] : Object.values(NAMESPACE_OF).map((ns) => `${ns}.commit`), by: '--commit' });
  }
  if ((values['allow'] as string[] | undefined)?.length) out.push({ leaves: ['allowedTools'], by: '--allow' });
  let setAllowed = false;
  for (const raw of (values['set'] as string[] | undefined) ?? []) {
    const eq = raw.indexOf('=');
    const key = raw.slice(0, eq).trim();
    if (key === 'allowedTools') {
      if (setAllowed) continue;
      setAllowed = true;
    }
    let leaves = [key];
    if (CONFIG_BLOCKS.includes(key)) {
      try {
        const parsed: unknown = JSON.parse(raw.slice(eq + 1));
        if (isPlainObject(parsed)) leaves = Object.keys(parsed).map((l) => `${key}.${l}`);
      } catch {
        /* parseSetFlags has refused it */
      }
    }
    if (leaves.length) out.push({ leaves, by: `--set ${key}` });
  }
  return out;
}

/** One leaf named twice in one call, or a block and a leaf under it, is refused before anything is sent. */
function refuseNamedTwice(namings: Naming[]): void {
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
  for (let i = 0; i < namings.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = namings[j] as Naming;
      const b = namings[i] as Naming;
      const hit = a.leaves.flatMap((x) => b.leaves.filter((y) => overlaps(x, y)).map((y) => (x.length >= y.length ? x : y)))[0];
      if (hit !== undefined) throw new Error(`config: ${a.by} and ${b.by} both name ${hit}; give each key once per call`);
    }
  }
}

export async function runCli(argv: string[]): Promise<CliResult> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    return { status: 0, body: { usage: USAGE } };
  }
  const { values, positionals } = parseArgs({
    args: joinNumericValues(argv),
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      'data-dir': { type: 'string' },
      repo: { type: 'string' },
      reap: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      'head-sha': { type: 'string' },
      'wip-commit': { type: 'string' },
      release: { type: 'boolean', default: false },
      reason: { type: 'string' },
      answer: { type: 'string' },
      'accept-candidate': { type: 'boolean', default: false },
      sha: { type: 'string' },
      version: { type: 'string' },
      note: { type: 'string' },
      launch: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      result: { type: 'string' },
      error: { type: 'string' },
      'override-budget': { type: 'boolean', default: false },
      'end-live': { type: 'boolean', default: false },
      cascade: { type: 'boolean', default: false },
      status: { type: 'string' },
      'node-id': { type: 'string' },
      payload: { type: 'string' },
      task: { type: 'string' },
      full: { type: 'boolean', default: false },
      'stat-lines': { type: 'string' },
      'summary-chars': { type: 'string' },
      access: { type: 'string' },
      set: { type: 'string', multiple: true },
      'check-command': { type: 'string' },
      capacity: { type: 'string' },
      allow: { type: 'string', multiple: true },
      'runner-command': { type: 'string' },
      'runner-kind': { type: 'string' },
      sandbox: { type: 'string' },
      permission: { type: 'string' },
      commit: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      clear: { type: 'string', multiple: true },
    },
  });
  const [cmd, a, ...rest] = positionals;
  if (cmd === 'start') {
    const r = await startDaemon({ repo: values.repo, ...(values.set?.length ? { overrides: parseSetFlags(values.set) } : {}) });
    return { status: 200, body: r };
  }
  if (cmd === 'stop') {
    const r = await stopDaemon({ repo: values.repo, reap: values.reap });
    return { status: r.stopped ? 200 : 409, body: r };
  }
  if (cmd === 'runs') {
    return { status: 200, body: { runs: await listRuns() } };
  }
  // `config --data-dir shared|launch` is the opencode.dataDir leaf; any other value keeps naming the store.
  const dataDirLeaf = cmd === 'config' && (OPENCODE_DATA_DIRS as readonly string[]).includes(values['data-dir'] ?? '') ? values['data-dir'] : undefined;
  // With the daemon addressed by URL the store location is unused, so a mistyped leaf would vanish into a plain GET.
  if (cmd === 'config' && values['data-dir'] !== undefined && dataDirLeaf === undefined && (values.url || process.env['ORCH_URL'])) {
    throw new Error(
      `config --data-dir ${values['data-dir']}: with --url or ORCH_URL, --data-dir can only set opencode.dataDir (shared or launch); ` +
        'it names the store location only when no url is given',
    );
  }
  // Refused before the daemon is looked up, so a missing argument never revives one.
  if (cmd === 'review' && !a) throw new Error('review needs a milestone id');
  // `config --set` is parsed, and a leaf named twice refused, before anything is sent. See specs/operator-control "Configuration command: set flags".
  let setPatch: Overrides = {};
  if (cmd === 'config') {
    setPatch = values.set?.length ? parseSetFlags(values.set) : {};
    refuseNamedTwice(configNamings(values, dataDirLeaf));
  }
  const base = await resolveUrl({ url: values.url, dataDir: dataDirLeaf === undefined ? values['data-dir'] : undefined, repo: values.repo });
  switch (cmd) {
    case 'status':
      return call(base, 'GET', '/v1/status');
    case 'config': {
      // One PUT for every flag given; `--allow` appends to the rules already set by argument. See specs/operator-control "Configuration route".
      let patch: Record<string, unknown> = {};
      for (const k of values.clear ?? []) {
        // A per-kind key such as codex.sandbox clears one leaf of its namespace.
        const [ns, leafKey] = k.split('.');
        if (ns && leafKey) patch[ns] = { ...(patch[ns] as Record<string, unknown> | undefined), [leafKey]: null };
        else patch[k] = null;
      }
      if (values['check-command'] !== undefined) patch['checkCommand'] = values['check-command'];
      if (values.capacity !== undefined) patch['capacity'] = Number(values.capacity);
      if (values['runner-command'] !== undefined) patch['runnerCommand'] = values['runner-command'];
      if (values['runner-kind'] !== undefined) patch['runnerKind'] = values['runner-kind'];
      if (values.model !== undefined) patch['model'] = values.model;
      if (values.effort !== undefined) patch['effort'] = values.effort;
      if (values.sandbox !== undefined) patch['sandbox'] = values.sandbox;
      if (values.permission !== undefined) patch['permission'] = values.permission;
      if (dataDirLeaf !== undefined) patch['dataDir'] = dataDirLeaf;
      if (values.commit !== undefined) patch['commit'] = values.commit;
      // The commit policy is per kind: it binds to --runner-kind, else to the kind in force. Clearing runnerKind in the
      // same call would bind it to the outgoing kind, so that combination needs --runner-kind to say which.
      if (values.commit !== undefined && patch['runnerKind'] === null) {
        throw new Error('--clear runnerKind with --commit: name the kind the commit policy binds to with --runner-kind, or clear in a separate call');
      }
      const kind = values.commit === undefined || isRunnerKind(patch['runnerKind']) ? undefined : ((await call(base, 'GET', '/v1/config')).body as { config?: { runnerKind?: { value?: RunnerKind } } }).config?.runnerKind?.value;
      patch = foldRunnerArgs(patch, kind ?? 'claude-code');
      if (values.allow?.length) {
        const cur = await call(base, 'GET', '/v1/config');
        const existing = (cur.body as { overrides?: { allowedTools?: string[] } }).overrides?.allowedTools ?? [];
        patch['allowedTools'] = [...existing, ...values.allow.filter((r) => !existing.includes(r))];
      }
      // --set merges per leaf: different leaves of one block (--set codex.model=... --sandbox read-only) land together.
      for (const [k, v] of Object.entries(setPatch)) {
        if (v === undefined) continue;
        const cur = patch[k];
        patch[k] = isPlainObject(v) && isPlainObject(cur) ? { ...cur, ...v } : v;
      }
      if (values['end-live']) return call(base, 'PUT', '/v1/config', { ...patch, endLive: true });
      if (!Object.keys(patch).length) return call(base, 'GET', '/v1/config');
      return call(base, 'PUT', '/v1/config', patch);
    }
    case 'answer':
      return call(base, 'POST', `/v1/tasks/${a}/answer`, { text: rest.join(' ') });
    case 'cancel':
      return call(base, 'POST', `/v1/tasks/${a}/cancel`, { reason: values.reason ?? 'cancelled by operator', release: values.release });
    case 'reopen':
      return call(base, 'POST', `/v1/tasks/${a}/reopen`, { cascade: values.cascade });
    case 'proposals':
      return call(base, 'GET', `/v1/proposals${values.status ? `?status=${encodeURIComponent(values.status)}` : ''}`);
    case 'accept-proposal':
      if (!a) throw new Error('accept-proposal needs a proposal id');
      return call(base, 'POST', `/v1/proposals/${a}/accept`, { nodeId: values['node-id'], payload: values.payload ? (JSON.parse(values.payload) as Record<string, unknown>) : undefined });
    case 'reject-proposal':
      if (!a) throw new Error('reject-proposal needs a proposal id');
      return call(base, 'POST', `/v1/proposals/${a}/reject`, { note: values.note ?? rest.join(' ') });
    case 'unblock':
      return call(base, 'POST', `/v1/tasks/${a}/unblock`, { answer: values.answer, acceptCandidate: values['accept-candidate'] });
    case 'accept':
      return call(base, 'POST', `/v1/milestones/${a}/accept`, { sha: values.sha, version: Number(values.version) });
    case 'reject':
      return call(base, 'POST', `/v1/milestones/${a}/reject`, { note: values.note ?? rest.join(' ') });
    case 'review': {
      // The daemon checks every value; see specs/operator-control "Review bundle".
      const q = new URLSearchParams();
      if (values.task !== undefined) q.set('task', values.task);
      if (values.full) q.set('full', 'true');
      if (values['stat-lines'] !== undefined) q.set('statLines', values['stat-lines']);
      if (values['summary-chars'] !== undefined) q.set('summaryChars', values['summary-chars']);
      const qs = q.toString();
      return call(base, 'GET', `/v1/milestones/${encodeURIComponent(a as string)}/review${qs ? `?${qs}` : ''}`);
    }
    case 'pause':
      return call(base, 'POST', '/v1/pause');
    case 'resume':
      return call(base, 'POST', '/v1/resume', { overrideBudget: values['override-budget'] });
    case 'mode':
      if (!a) throw new Error('mode needs spawn, pull, or mixed');
      return call(base, 'PUT', '/v1/runner', { mode: a });
    case 'claim':
      if (!a) throw new Error('claim needs a worker id');
      return call(base, 'POST', '/v1/claims', { workerId: a, taskId: values.task, access: values.access });
    case 'release':
      if (!a) throw new Error('release needs a launch id');
      return call(base, 'POST', `/v1/launches/${a}/release`, { reason: values.reason ?? rest.join(' '), ...(values.keep ? { keep: true } : {}), ...(values['head-sha'] ? { headSha: values['head-sha'] } : {}), ...(values['wip-commit'] ? { wipCommit: values['wip-commit'] } : {}) });
    case 'nudge':
      if (!a) throw new Error('nudge needs a task id and a message');
      return call(base, 'POST', `/v1/tasks/${a}/nudge`, { message: rest.join(' ') });
    case 'logs':
      return call(base, 'GET', `/v1/tasks/${a}/logs${values.launch ? `?launch=${values.launch}` : ''}`);
    case 'outbox': {
      const q = new URLSearchParams();
      if (values.after) q.set('after', values.after);
      if (values.limit) q.set('limit', values.limit);
      const qs = q.toString();
      return call(base, 'GET', `/v1/outbox${qs ? `?${qs}` : ''}`);
    }
    case 'ack': {
      if (!a) throw new Error('ack needs an effect id');
      if (values.error !== undefined) return call(base, 'POST', `/v1/outbox/${a}/nack`, { error: values.error });
      return call(base, 'POST', `/v1/outbox/${a}/ack`, { result: values.result ? (JSON.parse(values.result) as unknown) : {} });
    }
    case 'tick':
      return call(base, 'POST', '/v1/tick');
    default:
      throw new Error(`unknown command ${cmd ?? '(none)'}; see --help in the file header`);
  }
}

const isEntry = isEntrypoint(import.meta.url);
if (isEntry) {
  runCli(process.argv.slice(2))
    .then((r) => {
      const body = r.body as { log?: string; usage?: string } | undefined;
      if (body && typeof body.usage === 'string') process.stdout.write(body.usage);
      else if (body && typeof body.log === 'string') process.stdout.write(body.log);
      else process.stdout.write(`${JSON.stringify(r.body, null, 2)}\n`);
      process.exit(r.status < 400 ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(2);
    });
}
