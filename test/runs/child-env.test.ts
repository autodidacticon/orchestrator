/**
 * No store URL in child environments (ORC-87): the check command and a spawned agent print their environment,
 * and, while the process withholds (the default), neither DATABASE_URL, ORCH_RUN_ID nor any variable holding the
 * store URL is in it. With withholding off (a daemon on a SQLite store, ORC-115) the database variables return and
 * ORCH_RUN_ID stays removed. See specs/state-backend "No store URL in child environments" and "Withholding follows
 * the store".
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config.js';
import { childEnv, clearWithheldStoreUrls, isolationEnv, LIBPQ_VARS, postgresInputsWithoutKind, setStoreWithholding, storeWithholding, storeWithholdingFor, withholdStoreUrl, withoutStore } from '../../src/runs/childEnv.js';
import { type Resolved, storeReportOf } from '../../src/runs/resolve.js';
import { makeSlice, scriptedAgent, single, tsxLoader, type SliceHarness } from '../slice/harness.js';

const URL = 'postgresql://orch:pw-Zq9-s3cret@db.example:5432/orch';

/**
 * Every libpq variable that chooses a server, a user, a password, a service or password file, or a TLS/GSS
 * identity, spelled out here so that dropping one from LIBPQ_VARS fails this file (ORC-100).
 */
const LIBPQ_NAMES = [
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE',
  'PGSYSCONFDIR', 'PGOPTIONS', 'PGAPPNAME', 'PGSSLMODE', 'PGREQUIRESSL', 'PGSSLNEGOTIATION', 'PGSSLCOMPRESSION',
  'PGSSLCERT', 'PGSSLKEY', 'PGSSLPASSWORD', 'PGSSLCERTMODE', 'PGSSLROOTCERT', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGSSLSNI',
  'PGSSLKEYLOGFILE', 'PGREQUIREPEER', 'PGSSLMINPROTOCOLVERSION', 'PGSSLMAXPROTOCOLVERSION', 'PGMINPROTOCOLVERSION',
  'PGMAXPROTOCOLVERSION', 'PGGSSENCMODE', 'PGKRBSRVNAME', 'PGGSSLIB', 'PGGSSDELEGATION', 'PGCHANNELBINDING',
  'PGREQUIREAUTH', 'PGCONNECT_TIMEOUT', 'PGTARGETSESSIONATTRS', 'PGLOADBALANCEHOSTS',
] as const;
/** A store URL built from parts: the host and database in no URL, the password in PGPASSWORD. */
const LIBPQ_SET = Object.fromEntries(LIBPQ_NAMES.map((k) => [k, k === 'PGPASSWORD' ? 'pg-pw-Kx7-s3cret' : `v-${k}`]));
const SET = { DATABASE_URL: URL, DATABASE_URL_FILE: '/run/secrets/db/uri', ORCH_RUN_ID: 'team-a', APP_DB: URL, APP_DB_PADDED: ` ${URL}\n`, KEEP_ME: 'yes', ...LIBPQ_SET };

let h: SliceHarness | undefined;
let tmp: string | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  for (const k of Object.keys(SET)) delete process.env[k];
  clearWithheldStoreUrls();
});

function assertClean(text: string): void {
  expect(text).not.toMatch(/^DATABASE_URL=/m);
  expect(text).not.toMatch(/^ORCH_RUN_ID=/m);
  expect(text).not.toMatch(/^DATABASE_URL_FILE=/m);
  expect(text).not.toContain('pw-Zq9-s3cret');
  expect(text).not.toContain('db.example');
  expect(text).not.toContain('pg-pw-Kx7-s3cret');
  for (const k of LIBPQ_NAMES) expect(text, k).not.toMatch(new RegExp(`^${k}=`, 'm'));
  expect(text).toMatch(/^KEEP_ME=yes$/m);
}

describe('child environments carry no store connection', () => {
  it('childEnv and withoutStore drop DATABASE_URL, ORCH_RUN_ID and every variable whose value is the withheld URL', () => {
    Object.assign(process.env, SET);
    withholdStoreUrl(URL);
    const env = childEnv('/tmp/data', { EXTRA_DB: URL });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['DATABASE_URL']));
    for (const k of ['DATABASE_URL', 'ORCH_RUN_ID', 'APP_DB', 'APP_DB_PADDED', 'EXTRA_DB']) expect(env[k]).toBeUndefined();
    expect(env['KEEP_ME']).toBe('yes');
    // With no URL withheld and the filter in its default state (withholding), the names are still removed and other values kept.
    clearWithheldStoreUrls();
    expect(withoutStore({ DATABASE_URL: 'x', ORCH_RUN_ID: 'y', APP_DB: URL })).toEqual({ APP_DB: URL });
  });

  it('LIBPQ_VARS holds exactly the libpq names listed in this file, and each one is dropped by withoutStore, childEnv and isolationEnv', () => {
    expect([...LIBPQ_VARS].sort()).toEqual([...LIBPQ_NAMES].sort());
    // No store URL is withheld: the names go whatever their values (a URL built from parts matches nothing).
    clearWithheldStoreUrls();
    for (const k of LIBPQ_NAMES) {
      expect(withoutStore({ [k]: 'v', KEEP_ME: 'yes' }), k).toEqual({ KEEP_ME: 'yes' });
      expect(isolationEnv('/tmp/data')[k], k).toBe('');
    }
    Object.assign(process.env, LIBPQ_SET, { KEEP_ME: 'yes' });
    const env = childEnv('/tmp/data');
    for (const k of LIBPQ_NAMES) expect(env[k], k).toBeUndefined();
    expect(env['KEEP_ME']).toBe('yes');
    // Names that only look alike are kept.
    expect(withoutStore({ PGDATA: '/var/lib/pg', PG_HOST: 'x', MY_PGHOST: 'y' })).toEqual({ PGDATA: '/var/lib/pg', PG_HOST: 'x', MY_PGHOST: 'y' });
  });

  it('a check command and a spawned agent that print their environment see neither DATABASE_URL, DATABASE_URL_FILE, a libpq variable nor the store URL', async () => {
    Object.assign(process.env, SET);
    withholdStoreUrl(URL);
    tmp = mkdtempSync(path.join(tmpdir(), 'orc87-env-'));
    const checkOut = path.join(tmp, 'check.env');
    const agentOut = `${checkOut}.agent`;
    h = await makeSlice({
      graph: single('commitAndSubmit'),
      realVerifier: true,
      config: {
        checkCommand: `env > ${checkOut}`,
        runnerCommand: `env > ${agentOut} && node --import ${tsxLoader} ${scriptedAgent} {briefJson}`,
      },
    });
    await h.orch.tick();
    await h.waitFor(() => h!.orch.entry('T1').status.kind === 'done' || ['failed', 'conflict'].includes(h!.store.listJobs({ taskId: 'T1' })[0]?.status ?? ''));
    expect(h.orch.entry('T1').status.kind).toBe('done');
    const agentEnv = readFileSync(agentOut, 'utf8');
    assertClean(agentEnv);
    expect(agentEnv).toMatch(/^ORCH_LAUNCH_ID=/m);
    const checkEnv = readFileSync(checkOut, 'utf8');
    assertClean(checkEnv);
    expect(checkEnv).toMatch(/^ORCH_HOME=/m);
  });
});

describe('withholding follows the store (ORC-115)', () => {
  it('storeWithholdingFor: a Postgres store always withholds; a SQLite store withholds only with a Postgres input', () => {
    expect(storeWithholdingFor('postgres', [])).toBe(true);
    expect(storeWithholdingFor('postgres', ['store.urlFile'])).toBe(true);
    expect(storeWithholdingFor('postgres', ['ORCH_RUN_ID'])).toBe(true);
    expect(storeWithholdingFor('sqlite', ['ORCH_RUN_ID'])).toBe(true);
    expect(storeWithholdingFor('sqlite', ['store.flushDeadlineMs', 'ORCH_RUN_ID'])).toBe(true);
    expect(storeWithholdingFor('sqlite', [])).toBe(false);
  });

  it('postgresInputsWithoutKind lists the store keys and ORCH_RUN_ID only when the file does not write store.kind', () => {
    // No input: no file, no store block, a store that is not a mapping, a store that writes kind (either value), a blank ORCH_RUN_ID.
    expect(postgresInputsWithoutKind(undefined, {})).toEqual([]);
    expect(postgresInputsWithoutKind({ checkCommand: 'true', runner: { mode: 'spawn' } }, {})).toEqual([]);
    expect(postgresInputsWithoutKind({ store: 'postgres' }, {})).toEqual([]);
    expect(postgresInputsWithoutKind({ store: ['kind'] }, {})).toEqual([]);
    expect(postgresInputsWithoutKind({ store: null }, {})).toEqual([]);
    expect(postgresInputsWithoutKind({ store: { kind: 'sqlite' } }, {})).toEqual([]);
    expect(postgresInputsWithoutKind({ store: { kind: 'postgres', urlFile: '/run/u', runId: 'x', flushDeadlineMs: 1000 } }, { ORCH_RUN_ID: 'team-a' })).toEqual([]);
    expect(postgresInputsWithoutKind({ store: { kind: 'sqlite' } }, { ORCH_RUN_ID: 'team-a' })).toEqual([]);
    expect(postgresInputsWithoutKind(undefined, { ORCH_RUN_ID: '' })).toEqual([]);
    expect(postgresInputsWithoutKind(undefined, { ORCH_RUN_ID: '  \n' })).toEqual([]);
    // Neither DATABASE_URL, DATABASE_URL_FILE, a libpq name nor git.originUrl is an input.
    expect(postgresInputsWithoutKind({ git: { originUrl: 'https://git.example/a.git' } }, { DATABASE_URL: URL, DATABASE_URL_FILE: '/run/u', PGHOST: 'h', PGPASSWORD: 'p' })).toEqual([]);
    // Inputs: the store keys in file order as store.<key>, then ORCH_RUN_ID.
    expect(postgresInputsWithoutKind({ store: { urlFile: '/run/u', flushDeadlineMs: 1000 } }, {})).toEqual(['store.urlFile', 'store.flushDeadlineMs']);
    expect(postgresInputsWithoutKind(undefined, { ORCH_RUN_ID: 'team-a' })).toEqual(['ORCH_RUN_ID']);
    expect(postgresInputsWithoutKind({ store: { runId: 'r' } }, { ORCH_RUN_ID: ' team-a ' })).toEqual(['store.runId', 'ORCH_RUN_ID']);
  });

  it('with withholding off, withoutStore and childEnv keep the database variables and drop ORCH_RUN_ID, and isolationEnv blanks only ORCH_RUN_ID; clearWithheldStoreUrls restores the default', () => {
    Object.assign(process.env, SET);
    withholdStoreUrl(URL);
    expect(storeWithholding()).toBe(true);
    setStoreWithholding(false);
    expect(storeWithholding()).toBe(false);
    const input: Record<string, string> = { DATABASE_URL: URL, DATABASE_URL_FILE: '/run/secrets/db/uri', ORCH_RUN_ID: 'team-a', APP_DB: URL, KEEP_ME: 'yes', ...LIBPQ_SET };
    const kept = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'ORCH_RUN_ID'));
    expect(withoutStore(input)).toEqual(kept);
    for (const k of LIBPQ_VARS) expect(withoutStore({ [k]: 'v', ORCH_RUN_ID: 'x' }), k).toEqual({ [k]: 'v' });
    const env = childEnv('/tmp/data', { EXTRA_DB: URL });
    for (const k of ['DATABASE_URL', 'APP_DB', 'EXTRA_DB']) expect(env[k], k).toBe(URL);
    expect(env['DATABASE_URL_FILE']).toBe('/run/secrets/db/uri');
    for (const k of LIBPQ_VARS) expect(env[k], k).toBe(LIBPQ_SET[k]);
    expect(env['ORCH_RUN_ID']).toBeUndefined();
    expect(env['KEEP_ME']).toBe('yes');
    expect(env['ORCH_HOME']).toBe(path.join('/tmp/data', 'child-home'));
    const iso = isolationEnv('/tmp/data');
    expect(iso).not.toHaveProperty('DATABASE_URL');
    expect(iso).not.toHaveProperty('DATABASE_URL_FILE');
    for (const k of LIBPQ_VARS) expect(iso, k).not.toHaveProperty(k);
    expect(iso['ORCH_RUN_ID']).toBe('');
    for (const k of ['ORCH_URL', 'ORCH_REPO', 'ORCH_DATA_DIR']) expect(iso[k], k).toBe('');

    // The reset turns withholding back on: all three behave as before.
    clearWithheldStoreUrls();
    expect(storeWithholding()).toBe(true);
    withholdStoreUrl(URL);
    expect(withoutStore(input)).toEqual({ KEEP_ME: 'yes' });
    const again = childEnv('/tmp/data', { EXTRA_DB: URL });
    for (const k of ['DATABASE_URL', 'DATABASE_URL_FILE', 'ORCH_RUN_ID', 'APP_DB', 'EXTRA_DB', ...LIBPQ_VARS]) expect(again[k], k).toBeUndefined();
    const isoAgain = isolationEnv('/tmp/data');
    for (const k of ['DATABASE_URL', 'DATABASE_URL_FILE', 'ORCH_RUN_ID', ...LIBPQ_VARS]) expect(isoAgain[k], k).toBe('');
  });

  it('storeReportOf states whether this process withholds: true by default, false once withholding is off', () => {
    const resolved = { config: defaultConfig(), inputs: { fileRaw: undefined } } as unknown as Pick<Resolved, 'config' | 'inputs'>;
    expect(storeReportOf(resolved).withholdsDatabaseVariables).toBe(true);
    setStoreWithholding(false);
    expect(storeReportOf(resolved).withholdsDatabaseVariables).toBe(false);
    clearWithheldStoreUrls();
    expect(storeReportOf(resolved).withholdsDatabaseVariables).toBe(true);
  });

  /** Claim the one launch of a pull-mode slice of runner kind `kind`: the claim body's env block, and the daemon's agentEnv of that launch. */
  async function claimEnv(kind: 'codex' | 'opencode'): Promise<{ claimed: Record<string, string>; direct: Record<string, string> }> {
    h = await makeSlice({ graph: 'nodes:\n  - { id: T1, title: One, description: d, acceptanceCriteria: [a], deps: [], behavior: commitAndSubmit }', config: { runner: { mode: 'pull', kind } } });
    await h.waitFor(() => h!.store.listLaunches({ status: 'claimable' }).length === 1);
    const res = await fetch(`${h.orch.apiBaseUrl}/v1/claims`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workerId: 'w', runner: kind }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const claimed = (body[kind] as { env: Record<string, string> }).env;
    const launch = h.store.listLaunches().find((l) => l.launchId === body['launchId']);
    expect(launch).toBeDefined();
    const direct = h.orch.agentEnv(launch!);
    await h.cleanup();
    h = undefined;
    return { claimed, direct };
  }

  for (const kind of ['codex', 'opencode'] as const) {
    it(`the ${kind} claim's env block and agentEnv follow the switch: database variables blanked by default, absent with withholding off, ORCH_RUN_ID blanked in both`, async () => {
      const on = await claimEnv(kind);
      for (const env of [on.claimed, on.direct]) {
        expect(env['DATABASE_URL']).toBe('');
        expect(env['DATABASE_URL_FILE']).toBe('');
        expect(env['PGHOST']).toBe('');
        expect(env['ORCH_RUN_ID']).toBe('');
      }
      setStoreWithholding(false);
      const off = await claimEnv(kind);
      for (const env of [off.claimed, off.direct]) {
        expect(env).not.toHaveProperty('DATABASE_URL');
        expect(env).not.toHaveProperty('DATABASE_URL_FILE');
        for (const k of LIBPQ_VARS) expect(env, k).not.toHaveProperty(k);
        expect(env['ORCH_RUN_ID']).toBe('');
        expect(env['ORCH_URL']).toBe('');
      }
    });
  }
});

