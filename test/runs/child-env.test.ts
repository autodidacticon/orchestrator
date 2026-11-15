/**
 * No store URL in child environments (ORC-87): the check command and a spawned agent print their environment,
 * and neither DATABASE_URL, ORCH_RUN_ID nor any variable holding the store URL is in it.
 * See specs/state-backend "No store URL in child environments".
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnv, clearWithheldStoreUrls, isolationEnv, LIBPQ_VARS, withholdStoreUrl, withoutStore } from '../../src/runs/childEnv.js';
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
    // Without a withheld URL (SQLite), the names are still removed and other values kept.
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

